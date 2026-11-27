# Printei Cloud experimental

O painel usa a conta Bambu já vinculada à impressora. Uma consulta abre TLS em
`us.mqtt.bambulab.com:8883`, autentica com MQTT 3.1.1 e assina apenas
`device/<serial>/report`, em QoS 0. A escuta dura até oito segundos, incluindo
a conexão, e combina relatórios parciais dentro da janela. A atualização
automática é opcional e consulta a cada 30 segundos com o painel visível.

O cliente envia apenas MQTT CONNECT e SUBSCRIBE. O broker pode aceitar a
inscrição sem enviar um relatório nessa janela, especialmente em repouso.
O painel informa essa condição e exibe apenas dados recebidos na consulta.
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
os canais físicos depende do mapeamento do trabalho. O painel não importa
valores do fatiador nem modifica o estoque.

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
