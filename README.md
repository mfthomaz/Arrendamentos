# CasaThomaz

Aplicação web simples para gerir imóveis arrendados, contratos, cobranças e datas relevantes.

## Utilização

Sirva esta pasta através de um servidor HTTP local num navegador moderno. Na primeira utilização são criados cinco imóveis e quatro contratos de demonstração. Os dados adicionados ou alterados ficam no `localStorage` do navegador. Não existe backend, sincronização entre dispositivos, ligação bancária, processamento de pagamentos nem envio automático de emails/notificações.

A agenda cria uma tarefa de preparação do aviso dois meses antes da data de atualização anual registada no contrato. Pode copiar e rever um rascunho e marcar manualmente o aviso como enviado; a aplicação não o envia nem calcula coeficientes ou novos valores de renda. Confirme os prazos e requisitos legais aplicáveis antes de comunicar atualizações.

## Referências de produto

As funcionalidades implementadas foram inspiradas nas funcionalidades anunciadas nos sites oficiais consultados:

- [Landlord Studio — funcionalidades e planos](https://www.landlordstudio.com/pricing): gestão de imóveis, controlo manual de receitas, lembretes de renda, relatórios e armazenamento de documentos.
- [Buildium — plataforma e funcionalidades](https://www.buildium.com/features/): visão unificada de operações, arrendamentos, pagamentos, manutenção e capacidade de escalar carteiras.
- [Rentec Direct — funcionalidades](https://www.rentecdirect.com/features): contabilidade/relatórios, registo de rendas, gestão de contratos e comunicação com arrendatários.

As referências descrevem produtos comerciais próprios; a CasaThomaz implementa apenas uma seleção local e demonstrativa das ideias de organização e acompanhamento acima. Não reproduz pagamentos online, integrações bancárias, portais de arrendatários, contabilidade certificada ou notificações dos produtos referidos.

## Testes

```sh
npm test
```
