# legacy/

The first version of poly15. **Not used by the app.** Kept so the history in
[`docs/HISTORY.md`](../docs/HISTORY.md) can point at real code.

It targeted the **international** Polymarket (`gamma-api.polymarket.com` and
`clob.polymarket.com`), whose 15-minute BTC markets resolve on the Chainlink
BTC/USD stream and charge a taker fee of `0.25 x (p(1-p))^2` per share. The
owner's account is on **Polymarket US**, a separate CFTC-regulated exchange with
its own order book, its own API, and a different fee, so everything here was
replaced by `us.js` and `paper.js` in the repo root.

| file | what it did |
|---|---|
| `lib.js` | slug math (`btc-updown-15m-<epoch>`), Gamma/CLOB fetches, the international fee formula |
| `record.js` | standalone recorder writing `snapshots.jsonl` and `rounds.jsonl` |
| `strategies.js` | seven hand-written strategies and the evaluation core |
| `analyze.js` | command-line report of those strategies net of fees |

These files still run against the international API if you want to compare the
two venues, but nothing in the app depends on them.
