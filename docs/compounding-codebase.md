# The Compounding Codebase

The most expensive thing about AI coding isn't the API bill. It's repetition.

Last week I caught myself doing something for the fourth time. Explaining my codebase to Claude. The same conventions, the same gotchas, the same architectural decisions I'd already explained on Monday, Tuesday, and Thursday. By Friday the obvious thing landed. I was paying to teach the AI things I'd already taught it, in sessions now sitting as JSONL files in a directory I never reopen.

That's the problem. Not that AI coding is expensive. That every session teaches the model things it forgets the moment the session ends.

The economic frame is wrong anyway. The expensive part isn't tokens. It's the cost to me of re-explaining context I already explained. The cost of hitting bugs the AI has helped me solve before. The cost of making the same architectural decision twice because last month's reasoning is buried in a transcript I'd have to dig through by hand to find.

We've been thinking about this wrong. AI coding tools treat each session as stateless because models are stateless. But the work isn't stateless. The work compounds, or it should.

## The shallow workaround

Most tools acknowledge this in one narrow way: a project-level instructions file. Claude Code has CLAUDE.md. Cursor has .cursorrules. The pattern repeats across the ecosystem. You write down your conventions, your code style, your important context. The AI reads it at the start of every session.

This helps. But it's a snapshot, not a living record.

CLAUDE.md is whatever you remembered to put in it the last time you edited it. The pattern you discovered three sessions ago isn't there. The gotcha you hit on Wednesday isn't there. The decision about which database to use, the reasoning behind it, the alternatives you ruled out, none of it reaches CLAUDE.md unless you transcribe it by hand. Nobody does that consistently. Not over months.

So CLAUDE.md ages badly. It captures your project's surface, not its hard-won knowledge.

The deeper version of the problem: the work product of an AI coding session is not just the code. It's the reasoning. The exploration. The dead ends. The "I tried X and it didn't work because Y" that you'd kill to remember six months from now. None of that lands in CLAUDE.md, ever. It lands in a JSONL transcript you don't open.

## The pattern that works

In April, Andrej Karpathy published [a gist](https://gist.github.com/karpathy/442a6bf555914893e9891c11519de94f) describing a pattern he calls the LLM Wiki. The idea is simple. AI work should feed back into itself. Not as chat history, which is too noisy and too verbose to be useful at inference time. As a persistent, curated, structured artifact. A wiki. Pages. Topics. Cross-references. The kind of thing you'd want a senior engineer to maintain over years.

The key move in his framing: the wiki isn't documentation in the traditional sense. The human sources and directs. The LLM summarizes, cross-references, and maintains. The agent both writes to it, extracting durable knowledge from sources, and reads from it, loading relevant context before new work. Karpathy's own analogy is exact. Obsidian is the IDE, the LLM agent is the programmer, the wiki is the codebase.

That's the compounding part. Sessions feed the wiki. The wiki feeds future sessions. The more you use the AI, the sharper every future session gets.

This is an architectural shift, not a feature. Most AI tooling treats the session as the unit of work. The compounding model treats the knowledge base as the unit of work, and sessions as transient events that contribute to it.

## Two directions of feedback

There are two ways the knowledge base feeds back into sessions, and you want both.

The first is static injection. At the start of each session, the most important accumulated knowledge gets pulled into context. Top patterns. Top gotchas. Recent decisions. This is what an enhanced CLAUDE.md becomes when the wiki maintains it: a curated view of the most important things you know, refreshed continuously from what you've actually learned.

The second is dynamic retrieval. Mid-session, the AI queries the wiki for something specific. Have I dealt with this auth pattern before? What did I decide about error handling in this kind of API? What gotchas have I hit with this library? Real-time retrieval, in context, while the work happens.

These two flows differ in character. Static injection biases toward the universal. Dynamic retrieval handles the specific. The first is your AI starting smart. The second is your AI getting smarter as the task unfolds.

Building only one is the wrong shape. CLAUDE.md alone is too static. Pure RAG over your sessions is too passive. The architecture that works is both. A small curated injection on session start, plus a queryable knowledge base for mid-task retrieval.

## What compounding looks like at scale

The value isn't obvious in week one. Here's the shape of it over time.

Week one, your knowledge base is empty. Sessions feel normal. You write code, the AI helps, the session ends. Nothing remarkable.

Week four, maybe fifty notes in. Occasionally the AI catches something it shouldn't have caught. A gotcha specific to your codebase that no general-purpose model could have known. It's because the AI consulted the wiki before working.

Month three, two or three hundred notes. The AI consistently knows things specific to you. Your conventions. Your tech debt. Your architectural decisions and the reasons behind them. The context-setting you do per session drops noticeably.

Month six, you've crossed a threshold. The AI feels meaningfully sharper on your work than on a generic project. Not because the model changed. Because the knowledge layer between you and the model has accumulated real signal.

Year one, you have something only you have. A structured, queryable record of everything you've learned building with AI. Worth more than the codebase in some ways. The codebase is recoverable from version control. The reasoning isn't.

That's what compounding means. Not faster sessions. Not lower API costs. A qualitative shift in what AI-assisted development feels like, because the layer between you and the model is no longer empty.

## Own your data, own your AI

Two things are at stake here, and both are political.

The first is agency. Your sessions are training data for you, not for the model. The data won't fine-tune Claude or GPT or anything else. It makes you sharper and your specific work more productive. That's a different relationship than data-as-fuel-for-someone-else's-model. It's data as your own private knowledge layer.

The second is ownership. The knowledge base belongs in your local files, on your machine, in formats you can read and edit. Not in a cloud service that can shut down, change terms, raise prices, or lose interest in you as a customer. The infrastructure that compounds your work should be infrastructure you own.

This is the right move for the same reasons local-first software is the right move for most knowledge work. Your notes shouldn't need a subscription to be readable in 2030. Your knowledge base shouldn't either.

The major AI companies will build session memory natively. Cursor will. Anthropic will. Cognition will. When they do, it'll be cloud-locked, opaque, and tied to a subscription. Fine for many users. For anyone who treats accumulated knowledge as a genuine asset, an open, local, portable alternative matters. The same way Obsidian matters in a world of Notion.

## Vir, briefly

I built a tool to test this. It's called Vir. It runs locally, reads your Claude Code sessions, distills durable knowledge into structured markdown in an Obsidian vault, and exposes that vault as a tool Claude Code can query mid-session.

I ran it on my own history. Two hundred and twenty-six sessions in, one hundred and twenty-six distilled notes out, average confidence above 0.9. The best part has been the moments when Claude Code calls the query tool on its own and surfaces a gotcha I hit two months ago and had completely forgotten.

<!-- screenshot goes here: Claude Code calling vir_query mid-session and surfacing a forgotten gotcha, OR the Obsidian plugin's Related pane next to an open note -->

Since then it's grown in the direction the pattern points. There's an Obsidian plugin, live in the community marketplace, that surfaces related notes beside whatever you're working on. There's a compose command that synthesizes scattered notes into a single topic page. Both are the same bet. Knowledge encoded once, surfaced when it's useful, owned by you.

That's the compounding effect made visible. Knowledge I'd have rediscovered the hard way, surfaced automatically because I encoded it once.

Vir is open source, MIT licensed, at github.com/djolex999/vir. But the tool is less interesting than the pattern. The pattern is what matters.

## The bet

The bet, and the one I think makes sense for anyone working seriously with AI coding tools, is that value will increasingly live in the knowledge layer, not in the prompts or the model. Most of what's been built in AI coding so far is interface polish on top of stateless inference. Necessary, not sufficient. The next layer makes the work compound.

The value sitting in JSONL transcripts on developer machines right now is enormous. Most of it gets thrown away every day. Whoever figures out how to capture and compound it first will have an advantage that's invisible from outside and real every time they sit down to code.

This is the move. Local-first, structured, queryable, compounding knowledge layers on top of stateless models. The codebases that compound will pull away from the ones that don't.

Build the layer.
