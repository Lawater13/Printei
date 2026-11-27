package main

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

const testOrigin = "http://127.0.0.1:43872"

func printerPost(c *printerCloud, action, origin, body string) *httptest.ResponseRecorder {
	request := httptest.NewRequest(http.MethodPost, "/printer-cloud/"+action, strings.NewReader(body))
	request.Header.Set("Origin", origin)
	request.Header.Set("X-Printei-Printer", "1")
	response := httptest.NewRecorder()
	c.serve(response, request)
	return response
}

func TestPrinterAccessAndBambuSession(t *testing.T) {
	var received []string
	var body map[string]any
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		received = append(received, r.URL.Path)
		if r.Header.Get("CF-Access-Client-Id") != "client" || r.Header.Get("CF-Access-Client-Secret") != "secret" {
			t.Error("missing Access credentials")
		}
		if r.Header.Get("Origin") != "http://"+r.Host {
			t.Error("wrong Worker origin")
		}
		body = nil
		if err := json.NewDecoder(r.Body).Decode(&body); err != nil || body["key"] != "admin" {
			t.Error("missing Worker authentication")
		}
		if _, ok := body["clientSecret"]; ok {
			t.Error("Access secret was sent to the Worker JSON API")
		}
		if len(received) == 1 {
			w.WriteHeader(401)
			_, _ = w.Write([]byte(`{"error":"Sessão ausente ou expirada. Entre novamente com o código de e-mail."}`))
			return
		}
		_, _ = w.Write([]byte(`{"devices":[]}`))
	}))
	defer upstream.Close()
	c := newPrinterCloud(upstream.URL, testOrigin)
	expect := func(action, origin, payload string, status int) {
		t.Helper()
		got := printerPost(c, action, origin, payload)
		if got.Code != status {
			t.Fatalf("%s: status %d, expected %d, body %s", action, got.Code, status, got.Body)
		}
	}
	const connect = `{"clientId":"client","clientSecret":"secret","key":"admin"}`
	expect("connect", "https://other.test", connect, 403)
	expect("telemetry", testOrigin, "{}", 428)
	expect("connect", testOrigin, connect, 401)
	expect("send", testOrigin, `{"email":"test@example.com"}`, 200)
	if _, present := body["save"]; present {
		t.Fatal("request for email code attempted to save the session")
	}
	expect("login", testOrigin, `{"email":"test@example.com","code":"123456"}`, 200)
	if body["save"] != true || body["code"] != "123456" {
		t.Fatal("login did not request encrypted session persistence")
	}
	expect("telemetry", testOrigin, `{"device":1}`, 200)
	if body["device"] != float64(1) {
		t.Fatal("device selection not forwarded")
	}
	expect("logout", testOrigin, "{}", 404)
	expect("disconnect", testOrigin, "{}", 200)
	expect("session", testOrigin, "{}", 428)
	if strings.Join(received, ",") != "/bambu/session,/bambu/test,/bambu/test,/bambu/telemetry" {
		t.Fatalf("unexpected calls: %v", received)
	}
}

func TestPrinterAccessRedirectDoesNotForwardCredentials(t *testing.T) {
	var calls int
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		calls++
		http.Redirect(w, r, "/unexpected", http.StatusTemporaryRedirect)
	}))
	defer upstream.Close()
	c := newPrinterCloud(upstream.URL, testOrigin)
	res := printerPost(c, "connect", testOrigin, `{"clientId":"client","clientSecret":"secret","key":"admin"}`)
	if res.Code != 403 || calls != 1 || strings.Contains(res.Body.String(), "clientSecret") {
		t.Fatalf("unexpected redirect result: %d, %d calls", res.Code, calls)
	}
}
