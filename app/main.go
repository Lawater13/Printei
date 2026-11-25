package main

import (
 "bytes"
 "crypto/sha256"
 "embed"
 "encoding/hex"
 "encoding/json"
 "errors"
 "fmt"
 "io"
 "net"
 "net/http"
 "net/url"
 "os"
 "os/exec"
 "path/filepath"
 "regexp"
 "strconv"
 "strings"
 "sync"
 "sync/atomic"
 "syscall"
 "time"
 "unsafe"
)

//go:embed index.html logo.svg
var assets embed.FS

var version = "7.0"
const origin = "http://127.0.0.1:43871"
const addr = "127.0.0.1:43871"
const feed = "https://raw.githubusercontent.com/Lawater13/Printei/main/update.json"
const releasePrefix = "https://github.com/Lawater13/Printei/releases/download/"
var verPattern = regexp.MustCompile("^[0-9]{1,6}\\.[0-9]{1,6}$")
var user32 = syscall.NewLazyDLL("user32.dll")
var messageBox = user32.NewProc("MessageBoxW")
var beep = user32.NewProc("MessageBeep")

func notice(s string, flags uintptr) uintptr {
 a,_:=syscall.UTF16PtrFromString(strings.ReplaceAll(s,"\x00",""))
 b,_:=syscall.UTF16PtrFromString("Printei")
 n,_,_:=messageBox.Call(0,uintptr(unsafe.Pointer(a)),uintptr(unsafe.Pointer(b)),flags|0x40000)
 return n
}

type manifest struct { Version string `json:"version"`; URL string `json:"url"`; SHA string `json:"sha256"` }
func newer(a,b string) bool {
 if !verPattern.MatchString(a)||!verPattern.MatchString(b){return false}
 x,y:=strings.Split(a,"."),strings.Split(b,".")
 for i:=0;i<2;i++{p,_:=strconv.Atoi(x[i]);q,_:=strconv.Atoi(y[i]);if p!=q{return p>q}}
 return false
}
var client = &http.Client{Timeout:90*time.Second,CheckRedirect:func(r *http.Request,via []*http.Request)error{
 h:=r.URL.Hostname()
 if len(via)>5||r.URL.Scheme!="https"||r.URL.User!=nil||(h!="github.com"&&h!="raw.githubusercontent.com"&&!strings.HasSuffix(h,".githubusercontent.com")){return errors.New("Redirecionamento inválido")}
 return nil
}}
func get(u string,max int64)([]byte,error){
 req,e:=http.NewRequest("GET",u,nil);if e!=nil{return nil,e};req.Header.Set("Cache-Control","no-cache")
 r,e:=client.Do(req);if e!=nil{return nil,e};defer r.Body.Close()
 if r.StatusCode!=200{return nil,fmt.Errorf("HTTP %d",r.StatusCode)}
 b,e:=io.ReadAll(io.LimitReader(r.Body,max+1));if int64(len(b))>max{return nil,errors.New("Arquivo grande demais")};return b,e
}
func valid(m manifest) error {
 if !verPattern.MatchString(m.Version){return errors.New("Versão inválida")}
 expected:=releasePrefix+"v"+m.Version+"/Printei-V"+m.Version+"-Portable.exe"
 u,e:=url.Parse(m.URL)
 if e!=nil||m.URL!=expected||u.Scheme!="https"||u.User!=nil{return errors.New("Endereço de atualização inválido")}
 h,e:=hex.DecodeString(m.SHA);if e!=nil||len(h)!=32{return errors.New("SHA-256 inválido")};return nil
}
func check()(manifest,error){
 var m manifest
 b,e:=get(feed+"?t="+strconv.FormatInt(time.Now().Unix(),10),16384);if e!=nil{return m,e}
 if e=json.Unmarshal(b,&m);e!=nil{return m,e}
 if !verPattern.MatchString(m.Version){return m,errors.New("Versão inválida")}
 if newer(m.Version,version){e=valid(m)}
 return m,e
}
func verify(b []byte,m manifest) error{
 h:=sha256.Sum256(b);want,e:=hex.DecodeString(m.SHA)
 if e!=nil||len(b)<2||string(b[:2])!="MZ"||!bytes.Equal(h[:],want){return errors.New("Integridade do executável inválida")}
 return nil
}
var updating atomic.Bool
func install(m manifest) error {
 if e:=valid(m);e!=nil{return e}
 if !newer(m.Version,version){return errors.New("Nenhuma atualização nova")}
 b,e:=get(m.URL,100<<20);if e!=nil{return e};if e=verify(b,m);e!=nil{return e}
 self,e:=os.Executable();if e!=nil{return e}
 stage,e:=os.MkdirTemp(filepath.Dir(self),".printei-update-");if e!=nil{return e}
 success:=false;defer func(){if !success{os.RemoveAll(stage)}}()
 next:=filepath.Join(stage,"next.exe");helper:=filepath.Join(stage,"helper.exe")
 if e=os.WriteFile(next,b,0600);e!=nil{return e}
 old,e:=os.ReadFile(self);if e!=nil{return e};if e=os.WriteFile(helper,old,0600);e!=nil{return e}
 if e=exec.Command(helper,"--apply-update",self,m.Version,m.SHA).Start();e!=nil{return e};success=true
 return nil
}
func applyUpdate(target,newVersion,sha string)error{
 self,e:=os.Executable();if e!=nil{return e}
 stage:=filepath.Dir(self)
 if filepath.Dir(stage)!=filepath.Dir(target)||!strings.HasPrefix(filepath.Base(stage),".printei-update-")||!verPattern.MatchString(newVersion){return errors.New("Pasta de atualização inválida")}
 next:=filepath.Join(stage,"next.exe");b,e:=os.ReadFile(next);if e!=nil{return e}
 if e=verify(b,manifest{SHA:sha});e!=nil{return e}
 bak:=target+".bak";_ = os.Remove(bak)
 deadline:=time.Now().Add(30*time.Second)
 for {e=os.Rename(target,bak);if e==nil{break};if time.Now().After(deadline){return e};time.Sleep(350*time.Millisecond)}
 if e=os.Rename(next,target);e!=nil{_ = os.Rename(bak,target);_ = exec.Command(target).Start();return e}
 if e=exec.Command(target).Start();e!=nil{_ = os.Remove(target);_ = os.Rename(bak,target);_ = exec.Command(target).Start();return e}
 if strings.EqualFold(filepath.Base(target),"Printei-app.exe")&&strings.EqualFold(filepath.Base(filepath.Dir(target)),"PrinteiLauncher"){_ = os.WriteFile(filepath.Join(filepath.Dir(target),"version.txt"),[]byte(newVersion),0600)}
 return nil
}

type job struct { ID string `json:"id"`; Name string `json:"name"`; Deadline string `json:"deadline"` }
var alarms struct{sync.Mutex;jobs []job;ack map[string]bool;open string;active bool}
var manaus=time.FixedZone("Manaus",-4*3600)
func key(j job)string{return j.ID+"|"+j.Deadline}
func fire(j job){
 defer func(){alarms.Lock();alarms.active=false;alarms.ack[key(j)]=true;alarms.Unlock()}()
 beep.Call(0x30)
 if notice("Prazo de entrega: "+j.Name+"\n"+j.Deadline+"\n\nAbrir pedido?",4|32)==6{alarms.Lock();alarms.open=j.ID;alarms.Unlock()}
}
func scan(){
 alarms.Lock();defer alarms.Unlock()
 if alarms.active{return}
 for _,j:=range alarms.jobs {
  t,e:=time.ParseInLocation("2006-01-02T15:04",j.Deadline,manaus)
  if e==nil&&!alarms.ack[key(j)]&&!t.After(time.Now()){alarms.active=true;go fire(j);return}
 }
}
func authorized(r *http.Request,header string)bool{
 return r.Method=="POST"&&r.Host==addr&&r.Header.Get(header)=="1"&&(r.Header.Get("Origin")==""||r.Header.Get("Origin")==origin)
}
func reply(w http.ResponseWriter,v any){w.Header().Set("Content-Type","application/json; charset=utf-8");_ = json.NewEncoder(w).Encode(v)}
func fail(w http.ResponseWriter,e error){w.WriteHeader(400);reply(w,map[string]string{"error":e.Error()})}
var lastSeen atomic.Int64
const buttonScript = `<script>(function(){
const b=document.getElementById('updateCheck');if(!b)return;
async function request(path){const r=await fetch(path,{method:'POST',headers:{'X-Printei-Update':'1'},cache:'no-store'});const d=await r.json();if(!r.ok||d.error)throw Error(d.error||'Falha na atualização');return d}
b.onclick=async()=>{b.disabled=true;b.textContent='Verificando…';try{const m=await request('/update/check');if(!m.available){alert('Você já está na versão '+m.current+'.');return}if(!await confirmPrintei('Printei '+m.version+' disponível. Deseja baixar e reiniciar agora?'))return;b.textContent='Baixando…';await request('/update/install');b.textContent='Reiniciando…';alert('Atualização verificada. O Printei será reaberto. Se a janela antiga permanecer, feche apenas essa janela.');try{window.close()}catch{} }catch(e){alert('Não foi possível atualizar: '+e.message)}finally{b.disabled=false;b.textContent='↻ Atualizar'}};
setInterval(()=>fetch('/status',{cache:'no-store'}).catch(()=>{}),20000);
})();</script>`
func serve(w http.ResponseWriter,r *http.Request){
 if r.Host!=addr{http.Error(w,"Host inválido",403);return}
 w.Header().Set("X-Content-Type-Options","nosniff");w.Header().Set("Cache-Control","no-store")
 lastSeen.Store(time.Now().Unix())
 switch r.URL.Path{
 case "/status":reply(w,map[string]string{"version":version,"app":"Printei"});return
 case "/alarm":
  if !authorized(r,"X-Printei-Alarm"){http.Error(w,"Acesso negado",403);return}
  b,e:=io.ReadAll(io.LimitReader(r.Body,4097));if e!=nil||len(b)>4096{http.Error(w,"Mensagem inválida",400);return}
  go func(){beep.Call(0x30);notice(string(b),64)}();reply(w,map[string]bool{"ok":true});return
 case "/alarm-sync":
  if !authorized(r,"X-Printei-Alarm"){http.Error(w,"Acesso negado",403);return}
  var jobs []job;if e:=json.NewDecoder(http.MaxBytesReader(w,r.Body,2<<20)).Decode(&jobs);e!=nil||len(jobs)>5000{http.Error(w,"Dados inválidos",400);return}
  alarms.Lock();alarms.jobs=jobs;ack:=make([]string,0,len(alarms.ack));for k:=range alarms.ack{ack=append(ack,k)};opened:=alarms.open;alarms.open="";alarms.Unlock()
  reply(w,map[string]any{"ack":ack,"open":opened});scan();return
 case "/update/check","/update/install":
  if !authorized(r,"X-Printei-Update"){http.Error(w,"Acesso negado",403);return}
  if r.URL.Path=="/update/install"&&!updating.CompareAndSwap(false,true){fail(w,errors.New("Atualização em andamento"));return}
  m,e:=check()
  if r.URL.Path=="/update/check"{if e!=nil{fail(w,e);return};reply(w,map[string]any{"current":version,"version":m.Version,"available":newer(m.Version,version)});return}
  if e==nil{e=install(m)}
  if e!=nil{updating.Store(false);fail(w,e);return}
  reply(w,map[string]bool{"ok":true});if f,ok:=w.(http.Flusher);ok{f.Flush()};go func(){time.Sleep(2*time.Second);os.Exit(0)}();return
 case "/","/index.html":
  b,_:=assets.ReadFile("index.html");html:=strings.ReplaceAll(string(b),"Printei v6.2 Portable","Printei v"+version+" Portable");html=strings.Replace(html,"</html>",buttonScript+"</html>",1);w.Header().Set("Content-Type","text/html; charset=utf-8");_,_=io.WriteString(w,html);return
 case "/logo.svg","/icon-512.png","/icon-192.png","/favicon.ico":
  b,_:=assets.ReadFile("logo.svg");w.Header().Set("Content-Type","image/svg+xml");_,_=w.Write(b);return
 case "/manifest.webmanifest":
  w.Header().Set("Content-Type","application/manifest+json");_,_=io.WriteString(w,`{"name":"Printei","short_name":"Printei","start_url":"/","display":"standalone","icons":[{"src":"/logo.svg","sizes":"any","type":"image/svg+xml"}]}`);return
 default:http.NotFound(w,r)
 }
}
func edgePath()string{
 for _,root:=range []string{os.Getenv("ProgramFiles(x86)"),os.Getenv("ProgramFiles"),os.Getenv("LOCALAPPDATA"),os.Getenv("ProgramW6432")}{if root==""{continue};p:=filepath.Join(root,"Microsoft","Edge","Application","msedge.exe");if _,e:=os.Stat(p);e==nil{return p}}
 return ""
}
func main(){
 if len(os.Args)==5&&os.Args[1]=="--apply-update"{if e:=applyUpdate(os.Args[2],os.Args[3],os.Args[4]);e!=nil{notice("Atualização não instalada: "+e.Error(),16)};return}
 if len(os.Args)==2&&os.Args[1]=="--version"{fmt.Println(version);return}
 root:=os.Getenv("LOCALAPPDATA");if root==""{notice("LOCALAPPDATA indisponível.",16);return}
 profile:=filepath.Join(root,"Printei","Perfil")
 if e:=os.MkdirAll(profile,0700);e!=nil{notice(e.Error(),16);return}
 edge:=edgePath();if edge==""{notice("Microsoft Edge não encontrado.",16);return}
 l,e:=net.Listen("tcp",addr);if e!=nil{notice("Feche a outra versão do Printei antes de abrir esta.",48);return}
 alarms.ack=make(map[string]bool)
 lastSeen.Store(time.Now().Unix())
 srv:=&http.Server{Handler:http.HandlerFunc(serve),ReadHeaderTimeout:5*time.Second}
 go srv.Serve(l)
 go func(){for range time.NewTicker(time.Second).C{scan()}}()
 cmd:=exec.Command(edge,"--user-data-dir="+profile,"--app="+origin+"/","--no-first-run","--start-maximized")
 start:=time.Now();if e=cmd.Start();e!=nil{notice(e.Error(),16);return}
 go func(){_ = cmd.Wait();if time.Since(start)>5*time.Second&&!updating.Load(){os.Exit(0)}}()
 for range time.NewTicker(15*time.Second).C{if !updating.Load()&&time.Now().Unix()-lastSeen.Load()>300{return}}
}
