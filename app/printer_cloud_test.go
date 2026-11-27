package main

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strconv"
	"strings"
	"testing"
	"time"
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

func TestPrinterInteractiveAuthorization(t *testing.T) {
	grant := strings.Repeat("a", 64)
	var paths []string
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		paths = append(paths, r.URL.Path)
		cookie, err := r.Cookie("CF_Authorization")
		if err != nil || cookie.Value != "header.claims.signature" || r.Header.Get("Origin") != "http://"+r.Host {
			t.Error("missing Access authorization or Worker origin")
		}
		var body map[string]any
		if err := json.NewDecoder(r.Body).Decode(&body); err != nil || body["desktopGrant"] != grant {
			t.Error("missing scoped grant")
		}
		if _, ok := body["key"]; ok {
			t.Error("private key must stay out of desktop requests")
		}
		_, _ = w.Write([]byte(`{"devices":[{"name":"Suik Lab"}]}`))
	}))
	defer upstream.Close()
	c := newPrinterCloud(upstream.URL, testOrigin)
	var state string
	c.launch = func(value string) error { state = value; return nil }
	var saved printerCredentials
	c.save = func(value printerCredentials) error { saved = value; return nil }
	if got := printerPost(c, "connect", "https://other.test", "{}"); got.Code != 403 {
		t.Fatal("cross-origin launch accepted")
	}
	if got := printerPost(c, "session", testOrigin, "{}"); got.Code != 428 {
		t.Fatal("session unexpectedly available")
	}
	if got := printerPost(c, "connect", testOrigin, "{}"); got.Code != 200 || len(state) != 64 {
		t.Fatal("launch challenge missing")
	}
	if got := printerPost(c, "session", testOrigin, "{}"); !strings.Contains(got.Body.String(), `"pairing":true`) {
		t.Fatal("authorization status missing")
	}
	callback := func(origin, nonce string) *httptest.ResponseRecorder {
		body := url.Values{"state": {nonce}, "assertion": {"header.claims.signature"}, "grant": {grant},
			"expires": {strconv.FormatInt(time.Now().Add(time.Hour).UnixMilli(), 10)}}
		request := httptest.NewRequest(http.MethodPost, "/printer-cloud/callback", strings.NewReader(body.Encode()))
		request.Header.Set("Content-Type", "application/x-www-form-urlencoded")
		request.Header.Set("Origin", origin)
		response := httptest.NewRecorder()
		c.serve(response, request)
		return response
	}
	if got := callback("https://other.test", state); got.Code != 403 {
		t.Fatal("cross-origin callback accepted")
	}
	if got := callback(upstream.URL, strings.Repeat("b", 64)); got.Code != 403 {
		t.Fatal("wrong challenge accepted")
	}
	if got := callback(upstream.URL, state); got.Code != 200 || !saved.valid() {
		t.Fatalf("valid authorization rejected: %d %s", got.Code, got.Body)
	}
	if got := callback(upstream.URL, state); got.Code != 403 {
		t.Fatal("replay accepted")
	}
	// A new process recovers the protected credentials without launching WebView2.
	fresh := newPrinterCloud(upstream.URL, testOrigin)
	fresh.credentials = saved
	if got := printerPost(fresh, "session", testOrigin, "{}"); got.Code != 200 {
		t.Fatal("saved authorization failed to reconnect")
	}
	if got := printerPost(fresh, "telemetry", testOrigin, `{"device":0}`); got.Code != 200 {
		t.Fatal("telemetry denied")
	}
	if got := printerPost(fresh, "logout", testOrigin, "{}"); got.Code != 404 {
		t.Fatal("desktop authorization can mutate the Worker session")
	}
	if strings.Join(paths, ",") != "/bambu/session,/bambu/session,/bambu/telemetry" {
		t.Fatalf("unexpected requests: %v", paths)
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
	c.credentials = printerCredentials{Assertion: "a.b.c", Grant: strings.Repeat("a", 64), Expires: time.Now().Add(time.Hour).UnixMilli()}
	res := printerPost(c, "session", testOrigin, "{}")
	if res.Code != 403 || calls != 1 || strings.Contains(res.Body.String(), "a.b.c") {
		t.Fatalf("unexpected redirect result: %d, %d calls", res.Code, calls)
	}
}
