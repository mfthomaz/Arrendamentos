# CasaThomaz

Aplicação web/PWA para gerir imóveis, contratos, cobranças e datas relevantes. Pode funcionar localmente como demonstração ou sincronizar uma carteira privada com Supabase.

## Demonstração local

Sirva a pasta num servidor HTTP local, por exemplo com `npx serve .`, e abra o URL no navegador. A primeira execução sem Supabase cria cinco imóveis e quatro contratos de demonstração. Sem configurar um projeto, os dados ficam apenas no `localStorage` desse navegador e não são sincronizados.

## Supabase: configuração e segurança

1. Crie um projeto Supabase seu e guarde o URL do projeto e a respetiva chave **publishable** (ou `anon` legada) a partir do painel **Connect** / **API Keys**.
2. No **SQL Editor**, execute o conteúdo de [`supabase/schema.sql`](supabase/schema.sql). A tabela tem RLS forçada, não concede permissões a `anon`, e só permite a utilizadores autenticados ler, criar e atualizar a linha cujo `user_id` corresponde a `auth.uid()`. A chave `service_role`/secret nunca é usada pela aplicação.
3. Em **Authentication → Providers**, ative email/palavra-passe. Se a confirmação de email estiver ativa, confirme o endereço antes do primeiro início de sessão. Em **Authentication → URL Configuration**, configure o URL do website publicado como Site URL e permita o URL de desenvolvimento como redirect adicional, se necessário.
4. Em cada navegador/computador, abra **Configurar sincronização** na CasaThomaz e introduza o URL e a chave publicável. Estes valores são guardados no `localStorage` daquele navegador; não há chaves de projeto neste repositório.
5. Crie conta ou inicie sessão. Os dados só são pedidos ao Supabase depois da autenticação. As alterações sincronizam automaticamente; a aplicação também verifica atualizações ao voltar à janela e periodicamente.

Cada utilizador tem uma única carteira JSON na tabela `owner_data`. A aplicação usa revisão otimista para detetar edições concorrentes. Quando dois dispositivos editam registos com o mesmo identificador, conserva ambas as versões como cópias ligadas ao respetivo imóvel/contrato; não apaga uma versão silenciosamente.

### Migração dos dados existentes

Ao iniciar sessão no navegador que já contém dados da versão local, a aplicação apresenta uma escolha antes de migrar. **Juntar e sincronizar** cria primeiro uma cópia local de segurança e junta os dados à carteira Supabase, preservando versões em conflito como cópias. **Não importar agora** mantém a carteira da conta e arquiva localmente a cópia anterior; essa cópia pode depois ser importada pelo botão **Importar cópia local**. O registo local original não é apagado durante a migração.

Um utilizador novo, num navegador sem dados anteriores, começa com uma carteira vazia — não recebe os dados de demonstração. Dados offline só podem ser consultados/editados nesse navegador depois de uma sessão anterior ter carregado uma cópia local da própria conta. As edições offline ficam pendentes localmente e são sincronizadas quando a ligação regressa. O service worker guarda apenas o shell estático da aplicação; nunca guarda respostas da API, dados da carteira ou tokens de autenticação.

## Publicação da PWA com GitHub Pages

O workflow [`.github/workflows/pages.yml`](.github/workflows/pages.yml) testa e compila o site; publica automaticamente quando uma alteração chega à branch `main`, se Pages estiver ativado para o repositório. O URL do Pages usa o caminho do projeto, normalmente `https://mfthomaz.github.io/Arrendamentos/`. **O site ainda não está publicado**: não foram alteradas as definições do repositório nem criado/configurado um projeto Supabase.

Para ativar a publicação:

1. No GitHub, abra **Settings → Pages** no repositório e selecione **Build and deployment → Source: GitHub Actions**.
2. Em **Settings → Actions → General**, permita que os workflows executem. O workflow pede apenas `contents: read` na compilação e `pages: write`/`id-token: write` no passo de publicação; não requer secrets.
3. Depois de o workflow executar na `main`, abra o URL de Pages indicado no job `deploy`. Configure esse URL como Site URL e redirect permitido no Supabase, e configure o URL/chave publicável na aplicação em cada dispositivo.
4. Aceda ao URL com HTTPS num navegador compatível e escolha **Instalar app** quando o navegador oferecer a instalação. O manifesto e o service worker fornecem a instalação e a disponibilidade offline do shell.

O repositório atual é **público**. GitHub Pages publica um website acessível publicamente mesmo que o repositório seja privado, salvo a opção de publicação privada disponível apenas em GitHub Enterprise Cloud para sites de projeto de organizações. Em contas GitHub Free, a documentação exige um repositório público para Pages. Tornar o repositório privado não torna automaticamente a app ou os seus ficheiros estáticos privados.

**Limitação importante:** a documentação do GitHub Pages diz que Pages não se destina a alojar SaaS e que sites Pages não devem ser usados para transações sensíveis como envio de palavras-passe. Embora a palavra-passe seja enviada diretamente do navegador ao endpoint HTTPS do Supabase (não para um servidor GitHub), a aplicação contém autenticação. Confirme se este uso pessoal está de acordo com os termos e requisitos do seu plano/organização antes de ativar Pages. Se não estiver, publique o mesmo `dist/` num alojamento estático que permita esta aplicação autenticada; mantenha Supabase e as políticas RLS. Não publique no repositório ficheiros com dados pessoais ou uma chave Supabase secret/service-role.

## Limitações da sincronização

É necessária ligação ao projeto Supabase para autenticar e sincronizar; não existe edição colaborativa em tempo real. As alterações são verificadas em intervalos curtos, ao recuperar a ligação e ao voltar à aplicação. Em conflito simultâneo, podem surgir cópias que devem ser revistas manualmente. Os dados de demonstração são apenas locais e não são semeados numa conta nova. A aplicação não liga a bancos, não processa pagamentos e não envia notificações ou avisos aos arrendatários.

## Testes e build

```sh
npm test
npm run build
```

O build estático para Pages é criado em `dist/`; não contém configuração nem credenciais Supabase.

## Referências de funcionalidades de mercado

As páginas oficiais consultadas descrevem, entre outras, cobrança e acompanhamento de rendas na Landlord Studio, pagamentos online, operações e opções para diferentes dimensões de carteira na Buildium, e contabilidade, cobranças e ferramentas de gestão de arrendamentos na Rentec Direct. Daí foram selecionados para a CasaThomaz o registo de imóveis e contratos, o livro de cobranças/pagamentos e atrasos, um dashboard resumido e uma agenda de datas, ajustados ao uso pessoal pedido. A agenda inclui a preparação do aviso dois meses antes da atualização anual e permite escolher 3–6 meses de horizonte.

Estas referências não significam que a CasaThomaz inclua todas as funções desses produtos: não cobra rendas online, não oferece portal de inquilino, contabilidade integrada, sincronização bancária nem envio automático de mensagens. Não se comparam preços, que dependem do plano e mercado apresentados por cada fornecedor.

## Referências oficiais

- [Supabase — Row Level Security](https://supabase.com/docs/guides/database/postgres/row-level-security): políticas por linha e concessões de permissões são ambas necessárias.
- [Supabase — API keys](https://supabase.com/docs/guides/getting-started/api-keys): chave publicável no browser; chaves secret/service-role apenas em ambiente controlado.
- [Supabase — autenticação por palavra-passe](https://supabase.com/docs/guides/auth/passwords) e [URLs de redirecionamento](https://supabase.com/docs/guides/auth/redirect-urls).
- [GitHub Pages — fontes de publicação](https://docs.github.com/en/pages/getting-started-with-github-pages/configuring-a-publishing-source-for-your-github-pages-site) e [criação de um site](https://docs.github.com/en/pages/getting-started-with-github-pages/creating-a-github-pages-site).
- [GitHub Pages — limites e utilização](https://docs.github.com/en/pages/getting-started-with-github-pages/github-pages-limits) e [visibilidade](https://docs.github.com/en/enterprise-cloud@latest/pages/getting-started-with-github-pages/changing-the-visibility-of-your-github-pages-site).
- [Landlord Studio — funcionalidades e planos](https://www.landlordstudio.com/pricing), [Buildium — funcionalidades](https://www.buildium.com/features/) e [Rentec Direct — funcionalidades](https://www.rentecdirect.com/features/).
