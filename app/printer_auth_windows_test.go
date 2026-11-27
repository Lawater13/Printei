package main

import (
	"bytes"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

func TestWindowsAuthorizationUsesDPAPI(t *testing.T) {
	path := filepath.Join(t.TempDir(), "printer-access.dat")
	credential := printerCredentials{Assertion: "header.claims.signature", Grant: strings.Repeat("a", 64), Expires: time.Now().Add(time.Hour).UnixMilli()}
	if err := savePrinterAuthorization(path, credential); err != nil {
		t.Fatal(err)
	}
	data, err := os.ReadFile(path)
	if err != nil || bytes.Contains(data, []byte(credential.Assertion)) || bytes.Contains(data, []byte(credential.Grant)) {
		t.Fatal("plain-text authorization on disk")
	}
	if restored := loadPrinterAuthorization(path); restored != credential {
		t.Fatal("authorization could not be restored")
	}
	credential.Grant = strings.Repeat("b", 64)
	if err := savePrinterAuthorization(path, credential); err != nil || loadPrinterAuthorization(path) != credential {
		t.Fatal("authorization could not be replaced atomically")
	}
	if err := os.WriteFile(path, []byte("invalid"), 0600); err != nil || loadPrinterAuthorization(path).valid() {
		t.Fatal("invalid encrypted data accepted")
	}
}
