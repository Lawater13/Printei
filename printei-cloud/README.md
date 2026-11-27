# Printei Cloud experimental

O painel usa a conta Bambu já vinculada à impressora. Uma consulta abre TLS em
`us.mqtt.bambulab.com:8883`, autentica com MQTT 3.1.1 e assina apenas
`device/<serial>/report`, em QoS 0. A escuta dura até oito segundos, incluindo
a conexão, e reúne até 32 relatórios parciais por consulta. A atualização
automática é opcional e consulta a cada 30 segundos com o painel visível.

O cliente envia apenas MQTT CONNECT e SUBSCRIBE. O broker pode aceitar a
inscrição sem enviar um relatório nessa janela, especialmente em repouso.
O painel informa essa condição e conserva as últimas amostras já recebidas.
O endpoint protegido `POST /bambu/telemetry` devolve os campos normalizados
para uma futura integração à Visão geral do Printei.

## Sessão e hospedagem

- Mantenha a conta Cloudflare no plano **Workers Free**. A configuração usa
  um Durable Object SQLite, disponível no plano gratuito. As consultas ocorrem
  no Worker, sem serviço local ou conexão MQTT permanente. Uma aba com
  atualização ligada por 24 horas gera até 2.880 consultas por dia.
- Configure `PRINTEI_ADMIN_KEY` com uma chave privada de alta entropia e
  `PRINTEI_SESSION_KEY` com 32 bytes aleatórios em hexadecimal
  (gere com `openssl rand -hex 32`). Cadastre cada valor como segredo do
  Worker ou, em desenvolvimento local, em `.dev.vars` fora do Git.
- A sessão única do administrador contém apenas token, usuário MQTT e
  impressoras da conta. É cifrada com AES-GCM no servidor e expira em até
  24 horas, ou antes conforme o token. Um alarme remove a sessão vencida.
  A chave administrativa protege cada ação. O navegador mantém a chave
  no formulário enquanto a página está aberta e recebe apenas os dados
  necessários ao painel.
- Use **Remover sessão salva** para apagar a cópia do Printei Cloud. A ação
  não revoga o token na Bambu, e a rotação da chave de criptografia exige
  um novo login. A renovação usa um novo código de e-mail.
- O modo diagnóstico `POST /bambu/test` continua disponível sem persistência
  se a opção `save` estiver ausente.

## Filamento

O BMCU pode aparecer como unidade de alimentação compatível com AMS. O
painel usa os índices reportados para listar os canais e, quando presentes,
`tray_type` e `tray_color`. Campos ausentes ficam indisponíveis. A associação
entre a unidade reportada e os quatro canais físicos da Suik Lab requer um
teste do equipamento.

O esquema MQTT observado expõe metadados de bandeja e progresso. Ainda
falta confirmação de gramas efetivamente consumidos por cor. O Bambu Studio
grava `used_g` por filamento no `Metadata/slice_info.config` de um arquivo
fatiado. Esse valor é uma estimativa do fatiamento, e sua correspondência com
os canais físicos depende do mapeamento do trabalho. O painel exibe a estimativa da Bambu Cloud quando disponível e não modifica o estoque.

## Revisão e validação

A partir de `printei-cloud`, execute `node --test` e
`npx wrangler@4 deploy --dry-run --outdir /tmp/printei-worker`.
Para o teste com a Suik Lab, use um Worker isolado no plano gratuito após
aprovação, cadastre os segredos lá e autentique pelo painel. Teste em
repouso e durante uma impressão multicolor. Compare progresso, tempo e
temperaturas com o Bambu Studio, verifique a ordem dos quatro canais e
confirme que a sessão reabre após recarregar a página e deixa de abrir
após a remoção.

- [Sockets TCP e TLS do Workers](https://developers.cloudflare.com/workers/runtime-apis/tcp-sockets/)
- [Limites do Workers](https://developers.cloudflare.com/workers/platform/limits/)
- [Plano gratuito e armazenamento de Durable Objects](https://developers.cloudflare.com/durable-objects/platform/pricing/)
- [Padrão MQTT 3.1.1](https://docs.oasis-open.org/mqtt/mqtt/v3.1.1/os/mqtt-v3.1.1-os.html)
- [Mapeamento de relatórios Bambu Cloud, documentação comunitária](https://github.com/Doridian/OpenBambuAPI/blob/main/mqtt.md)
- [Código do projeto BMCU](https://github.com/karlingen/BMCU)
- [Exportação de gramatura no Bambu Studio](https://github.com/bambulab/BambuStudio/blob/master/src/libslic3r/Format/bbs_3mf.cpp)

### Implantação isolada após revisão

O `wrangler.jsonc` desta branch aponta para **printei-cloud-experimental**.
A migração `v1` cria o armazenamento da sessão nesse Worker. O endereço
esperado na conta com o subdomínio `suikeder` é
`https://printei-cloud-experimental.suikeder.workers.dev/`.

Com a conta Cloudflare autenticada no plano Workers Free, execute a partir
da raiz da branch experimental:

```sh
cd printei-cloud
npx wrangler@4 deploy --config wrangler.jsonc --dry-run --outdir /tmp/printei-worker
npx wrangler@4 deploy --config wrangler.jsonc
npx wrangler@4 secret put PRINTEI_ADMIN_KEY --config wrangler.jsonc
npx wrangler@4 secret put PRINTEI_SESSION_KEY --config wrangler.jsonc
```

Gere dois valores independentes com `openssl rand -hex 32` e informe cada
valor no prompt de seu segredo. Guarde a chave administrativa em um
gerenciador de senhas para abrir o painel. Confira o endereço que o
Wrangler imprimir antes de cadastrar os segredos. As rotas protegidas
exigem a chave administrativa e a gravação da sessão exige os dois segredos.

No endereço experimental, consulte `/health` e confirme
`stage: mqtt-experimental`. Consulte `/diagnostic` para verificar TLS.
Depois, abra o painel e entre com o código de e-mail da Bambu para testar
a Suik Lab. Se a inscrição for aceita e nenhum relatório chegar, repita
durante uma impressão para testar a escuta passiva.

[Segredos por Worker](https://developers.cloudflare.com/workers/configuration/secrets/)
e [migrações de Durable Objects](https://developers.cloudflare.com/durable-objects/reference/durable-objects-migrations/).

### Dados do monitor

O Durable Object acumula os relatórios por conta Bambu e impressora. Cada
medida, cor e material mantém seu próprio horário de recebimento. O painel
marca dados com mais de dois minutos como desatualizados. Mensagens MQTT
retidas podem preencher a primeira leitura, sem indicar conexão recente.
Na ausência de amostra ao vivo, a consulta de impressoras vinculadas pode
informar online ou offline. Silêncio no MQTT deixa a conexão indeterminada.

O tempo decorrido parte de `gcode_start_time` quando informado e inclui
pausas. A previsão usa o horário da amostra e o tempo restante enquanto a
impressora reporta estado de impressão. Velocidade é o percentual relativo
informado pelo firmware. Ventiladores são exibidos pelo nível reportado.

Durante as consultas, o Worker tenta ler `GET /v1/user-service/my/tasks`
no máximo uma vez a cada dois minutos por impressora em uso normal.
O histórico mostra até 30 encerramentos recentes obtidos pela API ou
observados pelo MQTT. A disponibilidade de tarefas depende da conta e
da API, e o MQTT passivo só registra transições recebidas enquanto uma
consulta está aberta. A leitura dos trabalhos pode disponibilizar
estimativas por cor via `amsDetailMapping.weight`, inclusive para um
trabalho interrompido. Esses valores representam o fatiamento e o painel
não os usa como consumo medido ou para descontar estoque.

A documentação comunitária descreve `pushing.pushall` como pedido de
status completo. Ele exige publicar em `device/<serial>/request` e a
permissão para esse tópico não foi confirmada. O monitor usa somente
CONNECT e SUBSCRIBE no MQTT, sem solicitar esse relatório.

- [Histórico e estimativas de filamento da Bambu Cloud](https://github.com/Doridian/OpenBambuAPI/blob/main/cloud-http.md#get-v1user-servicemytasks)
- [Pedido MQTT de status completo](https://github.com/Doridian/OpenBambuAPI/blob/main/mqtt.md#pushingpushall)
