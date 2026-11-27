package main

import (
	"encoding/hex"
	"encoding/json"
	"errors"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"unsafe"

	webview2 "github.com/jchv/go-webview2"
	"golang.org/x/sys/windows"
)

func printerDPAPI(data []byte, protect bool) ([]byte, error) {
	if len(data) == 0 {
		return nil, errors.New("Autorização vazia")
	}
	in := windows.DataBlob{Size: uint32(len(data)), Data: &data[0]}
	var out windows.DataBlob
	var err error
	if protect {
		err = windows.CryptProtectData(&in, nil, nil, 0, nil, windows.CRYPTPROTECT_UI_FORBIDDEN, &out)
	} else {
		err = windows.CryptUnprotectData(&in, nil, nil, 0, nil, windows.CRYPTPROTECT_UI_FORBIDDEN, &out)
	}
	runtime.KeepAlive(data)
	if err != nil {
		return nil, err
	}
	defer windows.LocalFree(windows.Handle(uintptr(unsafe.Pointer(out.Data))))
	return append([]byte(nil), unsafe.Slice(out.Data, out.Size)...), nil
}

func loadPrinterAuthorization(path string) printerCredentials {
	var credentials printerCredentials
	ciphertext, err := os.ReadFile(path)
	if err != nil || len(ciphertext) > 32768 {
		return credentials
	}
	data, err := printerDPAPI(ciphertext, false)
	if err != nil || json.Unmarshal(data, &credentials) != nil || !credentials.valid() {
		return printerCredentials{}
	}
	return credentials
}

func savePrinterAuthorization(path string, credentials printerCredentials) error {
	data, err := json.Marshal(credentials)
	if err != nil {
		return err
	}
	ciphertext, err := printerDPAPI(data, true)
	if err != nil {
		return err
	}
	file, err := os.CreateTemp(filepath.Dir(path), "printer-access-*.tmp")
	if err != nil {
		return err
	}
	defer os.Remove(file.Name())
	_, writeErr := file.Write(ciphertext)
	closeErr := file.Close()
	if writeErr != nil {
		return writeErr
	}
	if closeErr != nil {
		return closeErr
	}
	from, err := windows.UTF16PtrFromString(file.Name())
	if err != nil {
		return err
	}
	to, err := windows.UTF16PtrFromString(path)
	if err != nil {
		return err
	}
	return windows.MoveFileEx(from, to, windows.MOVEFILE_REPLACE_EXISTING|windows.MOVEFILE_WRITE_THROUGH)
}

func launchPrinterAuthorization(state string) error {
	exe, err := os.Executable()
	if err != nil {
		return err
	}
	cmd := exec.Command(exe, "--printer-auth", state)
	if err := cmd.Start(); err != nil {
		return err
	}
	go func() { _ = cmd.Wait() }()
	return nil
}

func showPrinterAuthorization(root, state string) {
	if _, err := hex.DecodeString(state); len(state) != 64 || err != nil {
		return
	}
	runtime.LockOSThread()
	defer runtime.UnlockOSThread()
	profile := filepath.Join(root, "Printei-WebView2-Test", "Access")
	if err := os.MkdirAll(profile, 0700); err != nil {
		notice("Não foi possível abrir o perfil de acesso.", 16)
		return
	}
	view := webview2.NewWithOptions(webview2.WebViewOptions{
		DataPath: profile, AutoFocus: true,
		WindowOptions: webview2.WindowOptions{Title: "Conectar impressora · Printei", Width: 720, Height: 720, Center: true, IconId: 1},
	})
	if view == nil {
		notice("WebView2 indisponível para autorização.", 16)
		return
	}
	defer view.Destroy()
	view.Navigate(printerCloudURL + "/desktop/connect?state=" + state)
	view.Run()
}
