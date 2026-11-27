# Printei
Sistema de gestão e orçamento para impressão 3D

## Printei V8.22 experimental para Windows

O artefato da branch `experimental/windows-v8.22-cloud` contém o EXE
portátil para Windows x64 e seu SHA-256. O Microsoft Edge WebView2 Runtime
precisa estar instalado. A V8.22 usa um perfil local próprio e uma porta
local separada da V8.21. Para copiar dados locais para teste, use o backup
da V8.21 e importe uma cópia no perfil experimental.

### Vincular o monitor

1. No Cloudflare Zero Trust, crie um Service Token dedicado para o teste.
   Autorize esse token com uma política **Service Auth** apenas no Access
   do Worker `printei-cloud-experimental`. A política existente para
   entrar no painel web pode continuar em uso.
2. Em **Configurações** da V8.22, preencha o Client ID, Client Secret e a
   chave privada do Printei experimental. O processo guarda esses valores
   em memória até desconectar ou fechar. O EXE e os backups não os contêm.
3. Se a sessão Bambu ainda estiver válida, o aplicativo reabre a sessão
   salva. Se estiver vencida, solicite e confirme o código de e-mail pelo
   formulário Bambu. O Worker guarda o token Bambu criptografado.
4. Abra **Visão geral** ou **Produção**. O aplicativo consulta o Worker a
   cada 30 segundos enquanto um desses painéis estiver visível. O histórico
   usa os trabalhos recentes disponibilizados pelo Worker. Os valores em
   gramas são estimativas por cor, sem movimentação de estoque.

[Service Tokens do Cloudflare Access](https://developers.cloudflare.com/cloudflare-one/access-controls/service-credentials/service-tokens/)
