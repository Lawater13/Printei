package main

import (
	"bytes"
	"crypto/rand"
	"crypto/subtle"
	"encoding/hex"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"strconv"
	"strings"
	"sync"
	"time"
)

const printerCloudURL = "https://printei-cloud-experimental.suikeder.workers.dev"

type printerCredentials struct {
	Assertion string `json:"assertion"`
	Grant     string `json:"grant"`
	Expires   int64  `json:"expires"`
}

func (c printerCredentials) valid() bool {
	_, err := hex.DecodeString(c.Grant)
	return len(c.Grant) == 64 && err == nil && len(c.Assertion) < 12000 &&
		strings.Count(c.Assertion, ".") == 2 && !strings.ContainsAny(c.Assertion, "\r\n; ,") &&
		c.Expires > time.Now().UnixMilli()
}

type printerCloud struct {
	mu          sync.Mutex
	credentials printerCredentials
	state       string
	deadline    time.Time
	revision    uint64
	client      *http.Client
	endpoint    string
	origin      string
	launch      func(string) error
	save        func(printerCredentials) error
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
	if r.URL.Path == "/printer-cloud/callback" {
		c.callback(w, r)
		return
	}
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	write := func(status int, message string) {
		w.WriteHeader(status)
		_ = json.NewEncoder(w).Encode(map[string]string{"error": message})
	}
	if r.Method != http.MethodPost || r.Header.Get("Origin") != c.origin || r.Header.Get("X-Printei-Printer") != "1" {
		write(http.StatusForbidden, "Acesso local negado.")
		return
	}
	if r.URL.Path == "/printer-cloud/connect" {
		var random [32]byte
		if _, err := rand.Read(random[:]); err != nil {
			write(500, "Não foi possível iniciar a autorização.")
			return
		}
		state := hex.EncodeToString(random[:])
		c.mu.Lock()
		c.state, c.deadline = state, time.Now().Add(10*time.Minute)
		c.revision++
		c.mu.Unlock()
		if err := c.launch(state); err != nil {
			c.mu.Lock()
			if c.state == state {
				c.state = ""
				c.deadline = time.Time{}
			}
			c.mu.Unlock()
			write(500, "Não foi possível abrir a janela de autorização.")
			return
		}
		_, _ = io.WriteString(w, "{}")
		return
	}
	var input struct {
		Device int `json:"device"`
	}
	if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, 1024)).Decode(&input); err != nil {
		write(http.StatusBadRequest, "Dados da solicitação inválidos.")
		return
	}
	c.mu.Lock()
	credentials := c.credentials
	pairing := time.Now().Before(c.deadline)
	c.mu.Unlock()
	if pairing && r.URL.Path == "/printer-cloud/session" {
		_, _ = io.WriteString(w, `{"pairing":true}`)
		return
	}
	if !credentials.valid() {
		write(http.StatusPreconditionRequired, "Conecte a impressora em Configurações.")
		return
	}
	payload := map[string]any{"desktopGrant": credentials.Grant}
	path := "/bambu/session"
	switch r.URL.Path {
	case "/printer-cloud/session":
	case "/printer-cloud/telemetry":
		path = "/bambu/telemetry"
		payload["device"] = input.Device
	default:
		write(http.StatusNotFound, "Rota desconhecida.")
		return
	}
	status, body, err := c.request(r, path, payload, credentials)
	if err != nil {
		write(status, err.Error())
		return
	}
	w.WriteHeader(status)
	_, _ = w.Write(body)
}

func (c *printerCloud) callback(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Content-Security-Policy", "default-src 'none'; frame-ancestors 'none'; base-uri 'none'")
	if r.Method != http.MethodPost || r.Header.Get("Origin") != c.endpoint {
		http.Error(w, "Origem da autorização inválida.", http.StatusForbidden)
		return
	}
	r.Body = http.MaxBytesReader(w, r.Body, 16384)
	if err := r.ParseForm(); err != nil {
		http.Error(w, "Autorização inválida.", http.StatusBadRequest)
		return
	}
	expires, _ := strconv.ParseInt(r.PostForm.Get("expires"), 10, 64)
	credentials := printerCredentials{Assertion: r.PostForm.Get("assertion"), Grant: r.PostForm.Get("grant"), Expires: expires}
	state := r.PostForm.Get("state")
	c.mu.Lock()
	if len(state) != 64 || subtle.ConstantTimeCompare([]byte(state), []byte(c.state)) != 1 ||
		!time.Now().Before(c.deadline) || !credentials.valid() {
		c.mu.Unlock()
		http.Error(w, "Autorização inválida ou expirada. Abra uma nova janela pelo Printei.", http.StatusForbidden)
		return
	}
	// Consume the challenge before contacting the Worker so simultaneous callbacks cannot both commit.
	revision := c.revision
	c.state = ""
	c.mu.Unlock()
	defer func() {
		c.mu.Lock()
		defer c.mu.Unlock()
		if c.revision == revision {
			c.deadline = time.Time{}
		}
	}()
	status, _, err := c.request(r, "/bambu/session", map[string]any{"desktopGrant": credentials.Grant}, credentials)
	if err != nil || status != http.StatusOK {
		http.Error(w, "O Worker não confirmou a sessão. Abra uma nova autorização pelo Printei.", http.StatusForbidden)
		return
	}
	c.mu.Lock()
	defer c.mu.Unlock()
	if c.revision != revision {
		http.Error(w, "Já existe uma autorização mais recente.", http.StatusConflict)
		return
	}
	if err := c.save(credentials); err != nil {
		http.Error(w, "Não foi possível salvar a autorização no Windows.", http.StatusInternalServerError)
		return
	}
	c.credentials = credentials
	w.Header().Set("Content-Type", "text/html; charset=utf-8")
	_, _ = io.WriteString(w, `<!doctype html><html lang="pt-BR"><meta charset="utf-8"><title>Autorização concluída</title><h1>Impressora conectada</h1><p>Feche esta janela para voltar ao Printei.</p></html>`)
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
	request.AddCookie(&http.Cookie{Name: "CF_Authorization", Value: credentials.Assertion})
	response, err := c.client.Do(request)
	if err != nil {
		return fail(http.StatusBadGateway, "Falha de comunicação com o Printei Cloud experimental.")
	}
	defer response.Body.Close()
	if response.StatusCode >= 300 && response.StatusCode < 400 || response.StatusCode == http.StatusForbidden {
		return fail(http.StatusForbidden, "A autorização expirou ou foi revogada. Conecte a impressora novamente.")
	}
	raw, err := io.ReadAll(io.LimitReader(response.Body, (1<<20)+1))
	var object map[string]json.RawMessage
	if err != nil || len(raw) > 1<<20 || json.Unmarshal(raw, &object) != nil || object == nil {
		return fail(http.StatusBadGateway, "O Printei Cloud retornou uma resposta incompatível.")
	}
	return response.StatusCode, raw, nil
}
