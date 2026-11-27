package main
import("testing";"crypto/sha256";"encoding/hex";"strings")
func TestVersions(t *testing.T){
 for _,c:=range []struct{a,b string;want bool}{{"7.1","7.0",true},{"7.10","7.9",true},{"7.0","7.0",false},{"6.2","7.0",false},{"x","7.0",false}}{if newer(c.a,c.b)!=c.want{t.Errorf("newer(%q,%q)",c.a,c.b)}}
}
func TestManifest(t *testing.T){
 m:=manifest{Version:"7.1",URL:releasePrefix+"experimental-v7.1/Printei-V7.1-Experimental-Portable.exe",SHA:strings.Repeat("a",64)}
 if e:=valid(m);e!=nil{t.Fatal(e)}
 m.URL=releasePrefix+"v7.1/Printei-V7.1-Portable.exe";if valid(m)==nil{t.Fatal("official channel accepted")}
 m.URL="https://example.com/x.exe";if valid(m)==nil{t.Fatal("external host accepted")}
}
func TestHash(t *testing.T){
 b:=[]byte("MZtest");h:=sha256.Sum256(b);m:=manifest{SHA:hex.EncodeToString(h[:])}
 if verify(b,m)!=nil{t.Fatal("valid hash rejected")};if verify([]byte("MZchanged"),m)==nil{t.Fatal("invalid hash accepted")}
}

func TestUI(t *testing.T){
 html:="<!doctype html><html>teste</html>";h:=sha256.Sum256([]byte(html))
 p:=uiPackage{Version:"999999.999999",Core:version,Commit:strings.Repeat("a",40),SHA:hex.EncodeToString(h[:]),HTML:html}
 if !uiVerify(p){t.Fatal("valid interface rejected")}
 p.HTML+="changed";if uiVerify(p){t.Fatal("invalid interface accepted")}
 p.HTML=html;p.Core="6.0";if uiVerify(p){t.Fatal("incompatible core accepted")}
}
