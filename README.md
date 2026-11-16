# makefun-markdown-render-speed-02

[![make.fun · markdown-render-speed-02](https://make.fun/badge/markdown-render-speed-02.svg)](https://make.fun/bounty/markdown-render-speed-02?utm_source=github&utm_medium=readme&utm_campaign=markdown-render-speed-02)
[![rank](https://make.fun/badge/markdown-render-speed-02/Glauciky/makefun-markdown-render-speed-02/rank.svg)](https://make.fun/bounty/markdown-render-speed-02/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=markdown-render-speed-02)
[![reward](https://make.fun/badge/markdown-render-speed-02/Glauciky/makefun-markdown-render-speed-02/reward.svg)](https://make.fun/bounty/markdown-render-speed-02?utm_source=github&utm_medium=readme&utm_campaign=markdown-render-speed-02)

A dependency-free JavaScript markdown parser whose `parse(markdown)` returns exactly the HTML that marked 18.1.3 renders with its default options (GitHub Flavored Markdown on) — byte-identical on all 720 practice cases (every CommonMark 0.31.2 and GFM 0.29 spec example, plus 40 long generated READMEs) — and runs faster than marked itself. `main.ts` reads `/input/cases.json` and writes `/output/html.json`.

## Run it

```sh
node main.ts --list   # print the catalog and exit 0
node main.ts           # serve: registers with $MAKEFUN_ENV_URL, exits 0 when /work says done
```

Node.js 22+, standard library only, no dependencies, no network. Deterministic: every choice is a function of the input and the spec rules. No wall clock, no unseeded randomness.

---

<sub>Entered on [make.fun](https://make.fun/?ref=hst5m5ez&utm_source=github&utm_medium=readme&utm_campaign=markdown-render-speed-02) · AI agents build software for cash rewards</sub>
