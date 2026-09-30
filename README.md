# POE2 Craft Assistant — núcleo e backend do overlay

Assistente de craft para **Path of Exile 2** em formato de overlay. O jogador faz
`Ctrl+C` no item e aperta **`Alt+E`**: o sistema lê o clipboard, converte o texto
em um objeto `Item` tipado, consulta a base de modificadores e devolve o plano
de craft — sequência exata de moedas, chance por tentativa e risco de brick.

Roda em TypeScript estritamente tipado, sem servidor, sem display e sem chave de
API (o planner determinístico cobre o caminho offline; a LLM apenas explica).

## Estrutura

```
src/
├── types/          # Interfaces + schemas Zod (Item, Modifier, CraftTarget, CraftPlan)
│   ├── item.ts         # Item, ItemModifier, ItemProperties, ItemClass
│   ├── crafting.ts     # CraftTarget, CraftStep, RiskAssessment, CostEstimate
│   └── modifiers.ts    # ModDefinition, OrbDefinition, OrbOdds
├── parser/         # Leitura e extração do texto do item (Clipboard)
│   └── itemParser.ts   # splitIntoItems, parseItemText, toItemModifier
├── scraper/        # Regras de mods e probabilidade (Axios + Cheerio + cache)
│   ├── poeDataService.ts  # resolveDesiredMod, estimateOdds, fetchOrbPriceInExalted
│   ├── catalog.ts         # catálogo de moedas e mods do patch 0.1
│   └── wikiCache.ts       # cache em memória + disco
├── overlay/        # Atalhos globais (Alt+E), clipboard e captura de tela
│   ├── hotkeyManager.ts   # Alt+E → clipboard → parse → Item
│   ├── hotkeySource.ts    # SimulatedHotkeySource / NativeHotkeySource
│   ├── clipboardReader.ts # Windows (PowerShell) / Unix / Simulated
│   └── screenCapture.ts   # captura de tela + bounds do item sob o cursor
├── agent/          # Agente de IA e o caminho de craft
│   ├── craftAgent.ts      # tool do Vercel AI SDK (currentItem + targetGoal)
│   └── craftPlanner.ts    # planner determinístico, custo, risco, slots
├── data/           # Base de craft: snapshot embutido, seed e fontes
│   ├── modsDbSnapshot.ts  # BUNDLED_MODS_SNAPSHOT + store seed
│   ├── seedDatabase.ts    # gerador único do snapshot
│   └── ipcSnapshotStore.ts# camadas disco → sessão → seed no renderer
├── ui/             # React do overlay (OverlayWindow, Settings, DataStatusBar)
├── host.tsx        # container que junta config, hotkey, hidratação e UI
├── dev/            # Ferramentas de teste (mockGameSimulator), fora do bundle
└── index.ts        # Simulação completa do fluxo
electron/           # Processo principal (CommonJS, sem build)
├── main.cjs              # BrowserWindow, IPC, snapshot em disco
├── preload.cjs           # contextBridge com sandbox: true
└── mainHotkeyManager.cjs # lifecycle do globalShortcut
```

## Scripts

| Comando | O que faz |
|---|---|
| `pnpm dev` | Roda a simulação completa (atalho → parser → scraper → agente) |
| `pnpm dev:overlay` | Sobe o Vite e o Electron juntos (janela de overlay) |
| `pnpm dev:mock` | `dev:overlay` + simulador de jogo: escreve itens reais no clipboard do SO e dispara o atalho global, em loop |
| `pnpm typecheck` | `tsc --noEmit` em modo strict |
| `pnpm test` | Testes (Vitest) de parser, overlay, scraper, planner e fixtures |
| `pnpm build` | Emite `dist/` com ESM + declarations e o bundle do renderer |
| `pnpm build:win` | `build` + `electron-builder --win`: gera o portable e o instalador NSIS em `release/` |
| `pnpm rebuild` | Recompila dependências nativas contra a ABI do Electron (`uiohook-napi`) |

### Simulador de jogo

`pnpm dev:mock` existe para exercitar o caminho real de captura
(`globalShortcut` → main lê o clipboard → renderer parseia) sem o Path of Exile 2
aberto. Ele grava no clipboard do sistema um item de verdade e sintetiza a
combinação de teclas do atalho — um atalho falso dentro do app passaria pelo
`onCaptured` sem provar que o `globalShortcut` está registrado.

```
pnpm dev:mock                          # loop, Alt+E, troca a cada 4s
pnpm dev:mock -- --once --index=1      # só o Peitoral Raro
pnpm dev:mock -- --hotkey=Ctrl+Alt+E   # outra combinação
pnpm dev:mock -- --dry-run             # só imprime, sem tocar no SO
```

`--activate` (padrão `Path of Exile`) traz o jogo para foreground antes de cada
captura; `--no-activate` pula isso.

### Empacotamento Windows

`electron-builder.yml` gera dois artefatos em `release/`:

| Target | Arquivo | Uso |
|---|---|---|
| `portable` | `PoE2 Craft Assistant-<versão>-portable.exe` | Executa direto da pasta ou pen drive |
| `nsis` | `PoE2 Craft Assistant-<versão>-setup.exe` | Instalador assistido, com escolha de diretório |

O `poe2_mods_db.json` versionado vai para `resources/data/` ao lado do executável
como referência; a base que o app usa é a embutida no bundle e, após a primeira
revalidação, a cópia em `%APPDATA%/poe2-craft-assistant/poe2_mods_db.json`.

`npmRebuild: true` no config faz o `@electron/rebuild` recompilar qualquer addon
nativo contra a versão do Electron antes de empacotar — sem isso, um módulo
compilado para o Node do sistema carrega e falha com `NODE_MODULE_VERSION` na
primeira captura. Adicionando `uiohook-napi` como dependência, ele entra no
asar desempacotado (`asarUnpack`) e precisa do `pnpm rebuild`.

Ainda não há `build/icon.ico`; até adicionar um, os instaladores usam o ícone
padrão do Electron.

## Fluxo

```
Alt+E → HotkeyManager → IClipboardReader → parseItemText → Item
                                                             ↓
                        CraftTarget (o que o jogador quer) ───┤
                                                             ↓
                                       PoeDataService (prefix/sufixo, tier, chance)
                                                             ↓
                                            planCraft → CraftPlan
                                                             ↓
                                  Tool do Vercel AI SDK → narrativa em PT-BR
```

### Atalho global

`HotkeyManager` registra `Alt+E` numa `IHotkeySource`. Em desenvolvimento e CI
usa-se a `SimulatedHotkeySource`; no overlay empacotado (Electron/Tauri) basta
ligar a `NativeHotkeySource` a um adaptador nativo (`uiohook-napi`,
`Electron.globalShortcut` ou o backend do Tauri) — o resto do núcleo não muda.

### Parser

No PoE2, `--------` separa **seções** do mesmo item, não itens. O parser corta
o clipboard pelos cabeçalhos `Item Class:` (é assim que vários itens copiados
aparecem) e depois lê, em ordem: header → propriedades → requisitos/sockets →
`Item Level` → modificadores. Cada linha vira um `ItemModifier` com `slot`
(prefix/suffix), `tier`, `origin` (implicit/crafted/enchant) e `magnitude`.

### Scraper

`PoeDataService` responde às três perguntas do agente:

1. **É prefixo ou sufixo?** → `resolveDesiredMod()`
2. **Qual tier mínimo no ilvl atual?** → `availableTiers` / `bestAvailableTier`
3. **Qual a chance por moeda?** → `estimateOdds()` (chance / neutro / brick / custo)

Fontes, em ordem: cache (memória → disco) → wiki via Axios + Cheerio →
catálogo local. Falha de rede nunca derruba o overlay.

### Agente

A tool `craftPlan` do Vercel AI SDK recebe **dois parâmetros**, como pedido:

```ts
craftPlan({ currentItem, targetGoal })
```

O `execute` não improvisa: chama `planCraft()`, que já fez a consulta de tiers
e probabilidades. A LLM só traduz o plano para linguagem natural — o prompt de
sistema proíbe explicitamente inventar chance, custo ou tier.

Sem `OPENAI_API_KEY`, `CraftAgent.planWithLlm()` cai automaticamente no planner
determinístico e devolve `source: 'heuristic'`.

## Decisões do planner

- **Slot livre → só moeda aditiva.** `Regal Orb`, `Transmutation` e `Augmentation`
  nunca removem nada, então nunca entram no plano com risco de brick.
- **Mod presente com valor abaixo do alvo → Annulment.** A chance de o Annulment
  acertar o modificador desejado é `1 / modificadores craftáveis`; o resto é
  classificado como brick.
- **`preserveExisting: true`** bloqueia qualquer remoção e explica por quê.
- **Mod protegido (implicit/enchant)** no slot com valor abaixo do alvo gera uma
  nota: só uma base diferente resolve.
- **Custo** usa espera geométrica (`1/chance`) com teto de 200 tentativas;
  o orçamento é conferido na moeda escolhida (`exalted`, `divine`, `chaos`).

## Variáveis de ambiente

Copie `.env.example` para `.env`. Todas são opcionais: sem elas o projeto usa o
catálogo local e o planner determinístico.

| Variável | Uso |
|---|---|
| `OPENAI_API_KEY` | Habilita a narrativa via LLM |
| `OPENAI_MODEL` | Modelo padrão (`gpt-4o-mini`) |
| `POE2_WIKI_MODIFIER_BASE_URL` | Fonte de mods para o scraper |
| `POE2_TRADE_SEARCH_URL` | Preço de mercado das moedas |
| `POE2_LEAGUE` | League para a trade API |