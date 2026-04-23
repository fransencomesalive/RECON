This is a [Next.js](https://nextjs.org) project bootstrapped with [`create-next-app`](https://nextjs.org/docs/app/api-reference/cli/create-next-app).

## Getting Started

First, run the development server:

```bash
npm run dev
# or
yarn dev
# or
pnpm dev
# or
bun dev
```

Open [http://localhost:3000](http://localhost:3000) with your browser to see the result.

You can start editing the page by modifying `app/page.tsx`. The page auto-updates as you edit the file.

This project uses [`next/font`](https://nextjs.org/docs/app/building-your-application/optimizing/fonts) to automatically optimize and load [Geist](https://vercel.com/font), a new font family for Vercel.

## Learn More

To learn more about Next.js, take a look at the following resources:

- [Next.js Documentation](https://nextjs.org/docs) - learn about Next.js features and API.
- [Learn Next.js](https://nextjs.org/learn) - an interactive Next.js tutorial.

You can check out [the Next.js GitHub repository](https://github.com/vercel/next.js) - your feedback and contributions are welcome!

## Deploy on Vercel

The easiest way to deploy your Next.js app is to use the [Vercel Platform](https://vercel.com/new?utm_medium=default-template&filter=next.js&utm_source=create-next-app&utm_campaign=create-next-app-readme) from the creators of Next.js.

Check out our [Next.js deployment documentation](https://nextjs.org/docs/app/building-your-application/deploying) for more details.

## AI workflow

This repo is set up for both Claude and Codex.

**Read these first at the start of any session:**
- `CLAUDE.md` (Claude) or `AGENTS.md` (Codex)
- `docs/current-state.md`
- `docs/architecture.md`
- `docs/known-gotchas.md`

**Keywords:**

| Keyword | When | What it does |
|---|---|---|
| `brief me` | Start of any Claude session | Read docs, summarize state, propose next step |
| `codex start` | Start of any Codex session | Read docs, summarize task, flag assumptions |
| `handoff` | End of session / before switching | Update docs/current-state.md, then commit and push |
| `polish` | Frontend pass (either tool) | Polish spacing, hierarchy, alignment, responsiveness |

**Cross-machine workflow:**
1. Finish task
2. `handoff` — Claude updates `docs/current-state.md`
3. `git add docs/ && git commit -m "handoff: [what's next]" && git push`
4. On the other machine: `git pull`
5. Start new session: `brief me` or `codex start`

**Dev setup:**
```bash
cd ~/Sites/RECON
git pull
npm run dev   # starts on :3000
```

**Production:** https://recon.mettlecycling.com
