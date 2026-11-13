<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="docs/brand/logo-dark.svg">
    <img src="docs/brand/logo-light.svg" alt="BiRefs" width="320">
  </picture>
</p>

<p align="center">
  <b>Bring Image References</b><br>
  Você sobe uma foto e recebe referências de desenho com o mesmo ângulo de rosto, a mesma pose ou a mesma mão.
</p>

<p align="center">
  <img src="docs/brand/app-screen.svg" alt="Tela do BiRefs: a foto no editor com a barra de ferramentas, a busca por palavra-chave e as referências parecidas" width="820">
</p>

- **Grátis de verdade:** sem anúncios, sem assinatura e com custo zero para hospedar.
- **Privado:** a IA (MediaPipe) roda no seu navegador e a foto não sai do aparelho na busca local.
- **Com crédito:** só imagens CC0 e CC BY (Openverse/Wikimedia), sempre com autor, licença e link para a fonte. As imagens são carregadas do servidor original.

## Tecnologias

| Parte | Ferramenta |
| --- | --- |
| Site | Vite, React, TypeScript, SCSS |
| IA no navegador | MediaPipe Tasks Vision (Face, Pose e Hand Landmarker) |
| Hospedagem e API | Cloudflare Pages, Pages Functions com Hono |
| Dados | Cloudflare D1 (cota exata) e KV (cache do token do DeviantArt) |
| Índice | Script Python com MediaPipe e Openverse, gerando JSON estático em `public/index/` |
| Testes | Vitest |

## Como rodar

Precisa de Node 22+ e, para gerar o índice, do [uv](https://docs.astral.sh/uv/).

```bash
npm install
npm run dev          # só o site, em http://localhost:5173
npm run pages:dev    # site + API, como no Cloudflare, em http://127.0.0.1:8788
npm test
```

Para refazer o índice (cerca de 5.500 imagens, algumas horas; se parar, ele retoma de onde estava):

```bash
npm run index
npm run index -- --selftest   # confere se o Python calcula igual ao site
```

## API

| Rota | O que faz |
| --- | --- |
| `GET /api/deviantart?tag=` | Busca por tag no DeviantArt, sem IA e sem conteúdo adulto. Devolve título, autor, miniatura e link. |
| `POST /api/web` | Botão "mais na web": envia a foto ao Google Vision. Precisa de `consent=true` e imagem JPEG, PNG ou WebP de até 4 MB. Tem limite por IP e cota mensal. |
| `GET /api/quota` | Diz se o botão "mais na web" ainda está ativo. |

Sem as chaves, as rotas respondem `503` dizendo o que falta. A coleção **BiRefs** no Postman tem as três rotas prontas para testar.

### Chaves

Nada de chave no código. Para testar localmente, copie `.dev.vars.example` para `.dev.vars` (que fica fora do git). Em produção:

```bash
npx wrangler pages secret put DEVIANTART_CLIENT_ID
npx wrangler pages secret put DEVIANTART_CLIENT_SECRET
npx wrangler pages secret put GOOGLE_VISION_KEY
```

Antes do primeiro deploy, crie o KV e o D1 (`npx wrangler kv namespace create birefs` e `npx wrangler d1 create birefs`), troque os ids `"local"` no `wrangler.toml` e rode `npx wrangler d1 migrations apply birefs --remote`.

## Fases

0. Protótipo: índice de exemplo e busca por ângulo no navegador.
1. MVP: índice com 5.546 fotos e desenhos, semelhança geral, celular e PWA. **(atual)**
2. DeviantArt por tag e o botão "mais na web" do Google, com aviso e consentimento.
3. Favoritos no localStorage, timer de sessão de desenho e crânio 3D opcional.
