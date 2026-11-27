# Printei
Sistema de gestão e orçamento para impressão 3D

## Printei V8.22 experimental para Windows

O artefato da branch `experimental/windows-v8.22-cloud` contém o EXE
portátil para Windows x64 e seu SHA-256. O Microsoft Edge WebView2 Runtime
precisa estar instalado. A V8.22 usa um perfil local próprio e uma porta
local separada da V8.21. Para copiar dados locais para teste, use o backup
da V8.21 e importe uma cópia no perfil experimental.

### Vincular o monitor

1. Na V8.22, abra **Configurações** e clique em **Conectar impressora**.
2. Na janela WebView2, entre pelo Cloudflare Access com sua conta autorizada.
   Confirme a primeira autorização com a chave privada do Printei experimental.
   Se a sessão Bambu no Worker estiver ausente ou vencida, vincule a conta
   com o código recebido por e-mail nessa mesma janela.
3. Ao reabrir o aplicativo, a conexão é retomada enquanto a autorização
   do Access e a sessão Bambu estiverem válidas. A autorização de leitura
   e o token do Access são protegidos por DPAPI no perfil do usuário Windows.
   A chave privada do Printei é usada somente na autorização interativa e
   não é gravada no aplicativo, no arquivo de autorização ou nos backups.
4. **Visão geral** e **Produção** consultam o Worker a cada 30 segundos
   enquanto visíveis. O histórico mostra os trabalhos recentes que o Worker
   disponibiliza. As estimativas em gramas não movimentam o estoque.

O Worker experimental verifica emissor, audiência, assinatura e validade
do Access na autorização inicial. A autorização do aplicativo vale apenas
para a sessão e a telemetria e está vinculada ao token individual do Access.

[Validação de tokens do Cloudflare Access](https://developers.cloudflare.com/cloudflare-one/access-controls/applications/http-apps/authorization-cookie/validating-json/)
