package main

import (
	"bytes"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"strings"
	"sync"
	"time"
)

const printerCloudURL = "https://printei-cloud-experimental.suikeder.workers.dev"

type printerCredentials struct {
	ClientID     string `json:"clientId"`
	ClientSecret string `json:"clientSecret"`
	Key          string `json:"key"`
}

type printerCloud struct {
	mu          sync.Mutex
	credentials printerCredentials
	client      *http.Client
	endpoint    string
	origin      string
}

func newPrinterCloud(endpoint, origin string) *printerCloud {
	return &printerCloud{
		endpoint: endpoint, origin: origin,
		client: &http.Client{Timeout: 28 * time.Second, CheckRedirect: func(*http.Request, []*http.Request) error {
			return http.ErrUseLastResponse
		}},
	}
}

func (c *printerCloud) serve(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Cache-Control", "no-store")
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	write := func(status int, message string) {
		w.WriteHeader(status)
		_ = json.NewEncoder(w).Encode(map[string]string{"error": message})
	}
	if r.Method != http.MethodPost || r.Header.Get("Origin") != c.origin || r.Header.Get("X-Printei-Printer") != "1" {
		write(http.StatusForbidden, "Acesso local negado.")
		return
	}

	var input struct {
		printerCredentials
		Email  string `json:"email"`
		Code   string `json:"code"`
		Device int    `json:"device"`
	}
	if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, 4096)).Decode(&input); err != nil {
		write(http.StatusBadRequest, "Dados da solicitação inválidos.")
		return
	}
	c.mu.Lock()
	credentials := c.credentials
	c.mu.Unlock()
	var path string
	payload := make(map[string]any)
	switch r.URL.Path {
	case "/printer-cloud/disconnect":
		c.mu.Lock()
		c.credentials = printerCredentials{}
		c.mu.Unlock()
		_, _ = io.WriteString(w, "{}")
		return
	case "/printer-cloud/connect":
		credentials = input.printerCredentials
		credentials.ClientID = strings.TrimSpace(credentials.ClientID)
		credentials.ClientSecret = strings.TrimSpace(credentials.ClientSecret)
		if credentials.ClientID == "" || credentials.ClientSecret == "" || credentials.Key == "" ||
			len(credentials.Key) > 1024 || strings.ContainsAny(credentials.ClientID+credentials.ClientSecret, "\r\n") {
			write(http.StatusBadRequest, "Informe as credenciais do Access e a chave privada do Printei.")
			return
		}
		path = "/bambu/session"
	case "/printer-cloud/session":
		path = "/bambu/session"
	case "/printer-cloud/send":
		path = "/bambu/test"
		payload["email"] = input.Email
	case "/printer-cloud/login":
		if len(input.Code) != 6 {
			write(http.StatusBadRequest, "Informe o código de seis dígitos.")
			return
		}
		path = "/bambu/test"
		payload["email"], payload["code"], payload["save"] = input.Email, input.Code, true
	case "/printer-cloud/telemetry":
		path = "/bambu/telemetry"
		payload["device"] = input.Device
	default:
		write(http.StatusNotFound, "Rota desconhecida.")
		return
	}
	if credentials.ClientID == "" {
		write(http.StatusPreconditionRequired, "Conecte o Printei Cloud em Configurações.")
		return
	}
	payload["key"] = credentials.Key
	status, body, err := c.request(r, path, payload, credentials)
	if err != nil {
		write(status, err.Error())
		return
	}
	if r.URL.Path == "/printer-cloud/connect" && (status == http.StatusOK || status == http.StatusUnauthorized) {
		c.mu.Lock()
		c.credentials = credentials
		c.mu.Unlock()
	}
	w.WriteHeader(status)
	_, _ = w.Write(body)
}

func (c *printerCloud) request(r *http.Request, path string, payload map[string]any, credentials printerCredentials) (int, []byte, error) {
	fail := func(status int, message string) (int, []byte, error) { return status, nil, errors.New(message) }
	body, err := json.Marshal(payload)
	if err != nil {
		return fail(http.StatusBadRequest, "Dados da solicitação inválidos.")
	}
	request, err := http.NewRequestWithContext(r.Context(), http.MethodPost, c.endpoint+path, bytes.NewReader(body))
	if err != nil {
		return fail(http.StatusBadGateway, "Falha ao preparar a solicitação ao Printei Cloud.")
	}
	request.Header.Set("Origin", c.endpoint)
	request.Header.Set("Content-Type", "application/json")
	request.Header.Set("CF-Access-Client-Id", credentials.ClientID)
	request.Header.Set("CF-Access-Client-Secret", credentials.ClientSecret)
	response, err := c.client.Do(request)
	if err != nil {
		return fail(http.StatusBadGateway, "Falha de comunicação com o Printei Cloud experimental.")
	}
	defer response.Body.Close()
	if response.StatusCode >= 300 && response.StatusCode < 400 {
		return fail(http.StatusForbidden, "Cloudflare Access exige um Service Token autorizado no Worker experimental.")
	}
	raw, err := io.ReadAll(io.LimitReader(response.Body, (1<<20)+1))
	var object map[string]json.RawMessage
	if err != nil || len(raw) > 1<<20 || json.Unmarshal(raw, &object) != nil || object == nil {
		if response.StatusCode == http.StatusForbidden || response.StatusCode == http.StatusUnauthorized {
			return fail(http.StatusForbidden, "Cloudflare Access recusou as credenciais. Confira a política Service Auth.")
		}
		return fail(http.StatusBadGateway, "O Printei Cloud retornou uma resposta incompatível.")
	}
	if response.StatusCode == http.StatusUnauthorized && path == "/bambu/session" && string(object["error"]) != `"Sessão ausente ou expirada. Entre novamente com o código de e-mail."` {
		return fail(http.StatusForbidden, "Cloudflare Access recusou as credenciais.")
	}
	return response.StatusCode, raw, nil
}
