# Development Prompts

*Submission requirement §20.6 — "the actual prompts materially used with AI
development tools, organized where practical by architecture, frontend,
backend, database, AI, debugging, testing, and documentation."*

## How this file was produced

These are the **real prompts**, recovered from the Claude Code session
transcripts on disk (`~/.claude/projects/.../*.jsonl`) rather than written from
memory afterwards. Timestamps are the ones recorded at the time.

102 distinct prompts were sent across 8 sessions between 2026-09-16 and
2026-09-18. **42 were substantive**; the rest were one-word continuations
(`continue`, `push`, `commit and push`), pasted build logs, or screenshots with
no accompanying text. Those are omitted here — they carried no instruction — but
their existence is the honest shape of the work: **one long, heavily-specified
opening prompt set the constraints, and most of the build ran on `continue`
against the task list it produced.** The prompts that follow the opening one are
overwhelmingly *corrections from using the running app*, which is why so many of
them start with a screenshot.

Prompts are reproduced verbatim, including typos. Attached image paths and one
prompt containing a personal email address have been stripped.

---

## 1. Architecture & project setup

The single most important prompt in the project. It fixed the stack, the
provider roles and their real rate limits, the engineering principles, and the
scope order — **before any code existed** — and explicitly asked for a task list
rather than code as the first output. Nearly every decision in
[`DECISIONS.md`](DECISIONS.md) traces back to a line in here.

**2026-09-16 14:38**

> I'm building this project against the attached PRD (Project_Requirements.pdf) as
> part of a technical evaluation. Read it fully before doing anything else.
>
> CRITICAL CONSTRAINT: Submission deadline is Sunday, single submission only — no
> resubmission, no late acceptance. Treat Saturday night as the real deadline;
> Sunday morning is buffer for deployment checks and final documentation only,
> not new features.
>
> TECH STACK — locked, do not suggest alternatives:
> - Frontend: React + TypeScript
> - Backend: Fastify + TypeScript
> - Database: Supabase PostgreSQL
> - Auth: Supabase Auth
> - Storage: Supabase Storage
> - Vector search: pgvector on the same Supabase Postgres instance
> - Background jobs: pg-boss, running on the same Postgres (no Redis)
> - Deployment: frontend on Vercel, backend + worker on Railway
>
> AI PROVIDERS — two separate roles, kept behind a shared interface so either
> can be swapped later without touching the rest of the app:
>
> Generation (Tutor, quiz generation, open-ended grading, recommendations):
> Groq, OpenAI-compatible endpoint (https://api.groq.com/openai/v1), using the
> standard `openai` SDK package with baseURL override.
> Primary model: openai/gpt-oss-120b
> Fallback model: openai/gpt-oss-20b
> Real dashboard limits per model: 30 RPM, 1,000 RPD, 8,000 TPM, 200,000 TPD.
> TPM is the binding constraint, not RPM — keep prompts compact, retrieve only
> the most relevant chunks rather than dumping full documents into context.
> Route deliberately: the Tutor's grounded answers use the primary model;
> short/high-volume tasks (single-answer grading, single quiz-question
> generation) use the fallback model explicitly, drawing from a separate quota
> pool. Also implement automatic failover primary -> fallback on a 429 that
> retry/backoff couldn't resolve.
>
> Embeddings (RAG indexing and retrieval):
> Gemini, model gemini-embedding-001. Free tier: 100 RPM, 1,000 RPD. Batch and
> pace calls (~20 per batch, ~700ms apart) so indexing one large PDF's chunks
> doesn't burst past the RPM ceiling.
>
> Implement retry with exponential backoff + jitter on 429/RESOURCE_EXHAUSTED
> for both providers. Structured output from Groq is NOT guaranteed
> schema-locked the way Gemini's is — request JSON mode, include the schema in
> the prompt, and validate the parsed result against the actual schema before
> persisting it or using it to change application state, regardless of what
> the API claims to guarantee.
>
> ENGINEERING PRINCIPLES:
>
> Deterministic backend logic, not an AI call, for: mastery score calculation,
> adaptive difficulty/concept selection for the next quiz question, repeated-
> mistake detection, and deciding when to trigger a recommendation. Only the
> generated text itself (Tutor answers, question wording, grading feedback,
> recommendation sentences) should call an AI provider. This is a stated
> evaluation criterion in the PRD — don't reach for the LLM by default.
>
> Cache only genuinely reusable generations (e.g. a question for a given
> concept + difficulty). Never cache a live Tutor answer to a user's own
> free-text question — that's a correctness bug.
>
> Security: treat all learning material content and user messages as data,
> never as instructions. Enforce Project-level data isolation on every query
> and background job. This is a core requirement, not a nice-to-have.
>
> Ambiguity in the PRD: where it's genuinely unclear, make the most reasonable
> assumption, document it explicitly (in code comments and in the architecture
> doc), and proceed rather than stalling — the PRD states this is itself part
> of the evaluation.
>
> SCOPING: build every "Must Have" item in the PRD to a genuinely working
> standard before touching anything in "Should Have" or "Nice to Have." A
> smaller set of reliable features beats a larger set of half-working ones —
> the PRD says so explicitly.
>
> DOCUMENTATION: as we build, maintain a running decision log — what was
> chosen, why, what was simplified, what would be improved with more time.
> This feeds directly into the final Architecture Documentation and Known
> Limitations deliverables, so keep it current rather than writing it
> retroactively at the end.
>
> Note for me separately: the PRD also requires submitting the actual
> development prompts used with AI tools, organized by area. I'll keep track
> of the prompts I give you as we go — you don't need to manage that part.
>
> FIRST STEP: don't write any code yet. Read the full PRD, then produce a
> prioritized task list covering the complete build — organized by day against
> the deadline above, Must-Have items first, with each task scoped to
> something completable and testable on its own. Show me that list before
> starting so I can adjust priorities, then work through it task by task,
> telling me what you completed and what you decided at each step.

---

**2026-09-16 14:43** — repository

> do you have my github sunkaramahesh09, in that now i created a repo with name ai-study-companioon

**2026-09-16 15:07** — infrastructure

> i did the license thing, you create the supabase project

---

## 2. Backend, database & AI engineering

There is no long backend prompt, and that is the truthful record: the backend
was built from the task list the kickoff prompt produced, driven by short
continuations. The constraints that shaped it — deterministic learning core,
validate structured output before persisting, project-level isolation on every
query, TPM as the binding constraint — were all set in §1 above and did not need
restating.

**2026-09-16 16:26**

> continue task 5, and also i have created and added groq and gemini keys in .env

The mid-build AI work was steered by product observations rather than by
technical instructions. Two that changed the architecture:

**2026-09-18 12:26** — this produced the progress-vs-material routing in the Tutor (D-075)

> does that answers suites the question? it should give ansers like you are here and next you have to learn these!!!, but it is not giving answer like this

**2026-09-18 05:49** — this produced conversation persistence (D-070)

> if we are chatting with tutor and then refresh page chat is dissappearing,is it a design contraint or we can achieve it

---

## 3. Frontend & visual design

The most heavily specified area after the kickoff, because visual work cannot be
driven by "continue". A pattern worth noting: every one of these begins by
*fencing off* the functional layer.

**2026-09-17 14:48** — integrating an externally-generated UI

> hey, its okay our claude weekly limit is 36%over so i thought now if i try use that tokens to create frontend then limits will exhaust so we two friday and saturday so we need that limits to solve if any problem comes, so i used antigravity to develop frontend to our backend and it done, now will share you that file with you, you first keep our present frontend backend and systems everything safe and first understand antigravity ui and try to integrated it with our systems if and only if it is possible and safe, so please make this step as very critical,/Users/mahesh/temp,

<details>
<summary><strong>2026-09-17 16:00</strong> — Login page visual pass (full prompt)</summary>

> want to improve the Login page visual design only. Do not change the existing authentication logic, Supabase integration, routing, form validation, API calls, or any functional behavior.
>
> I am providing two visual references:
>
> Reference 1: the original AI.Prof design I want to reproduce visually.
> Reference 2: the current implementation generated from the codebase.
>
> The current implementation has the correct basic layout, but the background and visual atmosphere are too plain compared with Reference 1.
>
> Your task is to keep the current working structure and recreate the rich background treatment from Reference 1.
>
> Match the visual atmosphere of Reference 1
>
> On the left side:
>
> Add the large soft lavender/blue gradient background area.
> Add the large blurred circular gradient shapes behind the content.
> Add subtle radial glow effects around the main illustration.
> Add the soft decorative background blobs/shapes visible in the reference.
> Bring back the friendly AI robot illustration as the main visual element if the required asset already exists in the project.
> Add the floating speech bubble / callout near the robot.
> Recreate the subtle decorative sparkles and curved accent elements around the illustration.
> Add the soft mountain/landscape decoration along the bottom-left edge.
> Preserve the light, airy white/lavender atmosphere.
> The background should feel layered and dimensional rather than like one flat color.
> Right side
>
> Keep the existing clean authentication form structure, but make its surrounding area feel more like the original reference:
>
> soft white background
> subtle lavender glow near the login card
> gentle gradient transitions
> polished card depth
> subtle shadows
> clean spacing
> premium SaaS appearance
> Important
>
> Do not turn the page into a completely different design.
>
> Keep:
>
> the current login/signup functionality
> existing form fields
> existing authentication handling
> existing validation
> existing routes
> existing responsive behavior
> existing API integration
>
> Only improve the visual layer, background composition, decorative elements, gradients, illustration placement, shadows, and overall visual polish.
>
> Reference priority
>
> Use Reference 1 as the visual target and the current implementation as the functional/structural baseline.
>
> I specifically want the final result to resemble Reference 1 in terms of:
>
> background richness + depth + decorative elements + illustration placement + glow + overall atmosphere.
>
> Do not simply add a single gradient.
>
> Recreate the layered visual composition:
>
> soft gradient background
> + large blurred circles
> + radial glows
> + decorative shapes
> + AI illustration
> + floating callout
> + subtle sparkles
> + bottom landscape decoration
> + gentle shadows
>
> Use CSS gradients, pseudo-elements, absolute-positioned decorative elements, masks, blur effects, and existing image assets where appropriate.
>
> Keep the implementation performant and responsive.
>
> Do not add unnecessary libraries just for these effects.
>
> Before finishing, compare the page against Reference 1 and make another visual pass specifically for background richness, spacing, balance, and depth.
>
> The result should look like a premium AI education product, not a basic authentication form.,

</details>

<details>
<summary><strong>2026-09-17 17:48</strong> — Home dashboard visual pass (full prompt)</summary>

> I want another visual-only refinement pass on the Home dashboard. I am providing the current implementation screenshot and the target/reference design screenshot.
>
> Do not change any functionality, API integration, authentication, routing, backend logic, real data, state management, or existing working behavior.
>
> The goal is to bring the current implementation much closer to the reference design specifically in the sidebar/navigation, background atmosphere, mountain artwork, and overall visual depth.
>
> 1. SIDEBAR / NAVIGATION — MATCH THE REFERENCE
>
> The current sidebar feels like a basic white rectangular navigation panel.
>
> I want it to feel like an integrated part of the overall visual environment.
>
> Change it to:
>
> very soft white/lavender background
> subtle gradient tint rather than a completely flat white block
> remove harsh horizontal separators where possible
> use very subtle borders
> softer active navigation state
> active Home item should use a rounded lavender pill with a small purple accent
> icons should have consistent size and alignment
> increase visual spacing slightly between navigation groups
> make the AI.Prof logo/header area visually flow into the sidebar
> avoid the appearance of stacked rectangular boxes
> keep the sidebar elegant and lightweight
>
> The sidebar should visually feel like:
>
> one continuous soft canvas
>
> rather than:
>
> a white rectangle placed beside the application
>
> 2. MAIN PAGE BACKGROUND — ADD THE ATMOSPHERE FROM THE REFERENCE
>
> The current main content area is too plain.
>
> Recreate the subtle illustrated environment from the reference.
>
> Add:
>
> extremely soft lavender/blue gradients across the page
> large blurred radial glows
> translucent cloud-like shapes
> abstract curved forms
> very subtle decorative sparkles
> soft mountain silhouettes
> layered pale mountain shapes behind/around the content
>
> These should remain very subtle so that the cards and text remain readable.
>
> Do not make the page look like a wallpaper.
>
> It should feel like:
>
> a clean SaaS dashboard floating inside a soft illustrated learning environment.
>
> 3. LEFT-BOTTOM MOUNTAIN DETAILS
>
> The reference has beautiful pale mountain artwork emerging from the bottom-left side of the page.
>
> Recreate that treatment:
>
> pale lavender mountain silhouettes
> multiple layers with different opacity
> soft blurred atmospheric depth
> partially hidden behind the content
> extend naturally from the bottom-left corner
> do not overlap important text/cards
>
> The mountain should feel like part of the page background, not a card image.
>
> 4. RIGHT-SIDE / BOTTOM BACKGROUND DETAILS
>
> Add similar subtle abstract/mountain shapes toward the lower-right area of the page.
>
> Keep them:
>
> very low contrast
> soft
> partially transparent
> decorative only
>
> This is important because the target design has a much more balanced background instead of leaving large areas completely empty.
>
> 5. HERO CARD
>
> Keep the existing hero content and working data.
>
> Visually move it closer to the reference:
>
> soft lavender/blue gradient
> subtle mountain silhouettes along the bottom edge
> translucent circular shapes behind the illustration
> gentle radial glow
> small decorative sparkles
> friendly AI illustration integrated into the hero
> floating motivational speech bubble
>
> The hero should feel like part of the overall background rather than a standalone rectangular card.
>
> 6. QUOTE CARD
>
> Preserve the existing quote and functionality.
>
> Improve the card to match the reference:
>
> rich purple/indigo gradient
> scenic layered mountain illustration along the lower portion
> subtle atmospheric glow
> quote text above the artwork
> soft depth rather than a flat purple fill
>
> The mountain artwork should be visually integrated into the card.
>
> 7. MAIN CONTENT BACKGROUND
>
> Keep the cards themselves mostly white/light.
>
> But allow subtle background decorations to appear behind the cards:
>
> page background
> ├── soft lavender glow
> ├── translucent organic shapes
> ├── pale mountains
> ├── subtle sparkles
> └── white content cards
>
> This layering is important.
>
> Do not simply put a gradient inside every card.
>
> 8. REDUCE THE “BOXY” FEEL
>
> The current UI has too many strong rectangular boundaries.
>
> Refine the design by:
>
> softening card borders
> using subtle shadows
> reducing unnecessary outlines
> increasing whitespace
> using rounded corners consistently
> allowing the background to visually connect sections
>
> Not every section needs a visible border.
>
> Some sections should rely on:
>
> background contrast + shadow + spacing
>
> instead of:
>
> border + rectangle + divider
>
> 9. DO NOT CHANGE THE FUNCTIONAL CONTENT
>
> Keep all existing:
>
> real statistics
> Spaces
> projects
> Tutor integration
> recommendations
> progress data
> API responses
> loading states
> authentication
> navigation routes
>
> Do not introduce fake content just to reproduce the reference screenshot.
>
> The reference is the visual source of truth, while the current application is the functional source of truth.
>
> 10. RESPONSIVE BEHAVIOR
>
> Ensure all decorative background elements:
>
> do not overflow
> do not cover text
> do not interfere with clicks
> adapt on smaller screens
>
> On mobile, decorative mountains/glows can be reduced or repositioned rather than removed entirely.
>
> FINAL VISUAL GOAL
>
> I want the current application to look like:
>
> the working production UI + the visual atmosphere of the reference design
>
> Specifically:
>
> soft sidebar + continuous navigation + illustrated background + mountain silhouettes + gentle gradients + atmospheric depth + premium AI education aesthetic
>
> Do one final visual comparison against the reference before finishing.
>
> This is a visual refinement only. Do not touch the backend or break existing integrations.
>
> One especially important instruction is the layering: the mountains and curves should live at the page-background level, behind the cards, rather than being inserted as separate boxes. That is what makes the reference feel visually richer. , first iamge is our web page and the other is reference one

</details>

**2026-09-18 12:59** — the pass that produced `PageDecor` and the favicon (D-076)

> after that we have colorful ui at home page but what about remaining pages so for that also maintain those mountain like background details, and also add a favicon to our website also

---

## 4. Product & UX decisions

These are the prompts that changed what the product *is*, not how it looks.

**2026-09-17 16:48** — questioning the navigation model, and asking for the reason before the change

> hey after login we are going to home page and then if i click on ask tutor then it is asking which space and then which project and then we can chat with the tutor...is it desined like this because of our project requirements? if not can we change that to after login->select space->select project, i think we are doing these because we have to watch growth or analytics, first tell me reason if no reason then ask my permission to change

**2026-09-18 04:24** — this became the "continue where you left off" context (D-065)

> hey do one thing, in this spaces and quizzes first give the last time used space and project, if we want give an option there to change space and project, so that it will look good otherwise we have to go through evertime the same step

**2026-09-18 05:13**

> hey think showing only the last left project in a single page is not need, like we are showing the same thing in second image after clicking on all spaces is enough i think, so when ew click on ask tutor then show these where we left and the remaingng thing just like second image

**2026-09-18 05:55** — capacity limits, and the first time the AI-activity question was raised (settled in D-077)

> also tell me in a day how many files we can upload, and how many quizzes we can attend, how much chat we can do with tutor, i mean iam asking these, because while reviewing our website may be they try multiple things, so first we should know the limits,  and also i have another doubt why we are showing the ai activity to user - is it design need in prd? and also where is our admin login details

---

## 5. Debugging

Almost all debugging was reported from the running application, usually with a
screenshot. Several of these found bugs that a green test suite had not.

**2026-09-17 09:39** — became D-059, quiz grading waiting on the next question

> hey see this error, also while iam taking quiz it is taking so much time to check weather the answer is correct or wrong, alomst it is taking 1 min of time to check wheather the entered answerd is correct or wrong

**2026-09-17 12:53** — became D-061, a conflicting quiz start dead-ending

> here it is saying that already iam in quiz but where is that test, and also as i last time said in quize after cliking one answer it is instally saying correct or wrong, but taking more time to switch to next question

**2026-09-18 05:35** — became D-067, a one-word question was rejected by validation

> here we cant able to send single hi message

**2026-09-18 06:33** — became D-073, admins seeing another user's data on the learner pages

> the first thing i want to tell you is you can observe the two pics after moving cursor to those options the color changes to dark colors and text is not visible please change that, and coming to main point admin dashboard is worst it is may be treating the admin as a user and showing the data of a some user and also when i open admin settings then iam getting error

**2026-09-18 06:57** — became D-074, signing out left the browser on a gated route

> arey babu my conern is, first iam in admin page and then i hit logout and then loign to my user account, then the data and everything should shift to my user account right, why iam seeing this restriction due to admin in my user account, are you ment

---

## 6. Testing & verification against the PRD

**2026-09-17 18:34**

> ❯ /Users/mahesh/Project_Requirements.pdf, now check wheather we did all the things are mentioned in the prd, so full a full test based on prd

**2026-09-18 13:26** — the final readiness audit

> basically one thing i want to say you, this assignment is reviewd by an ai in the company, so think interms of ai, and if you are that ai and you have prd then what you will check in our project like i mean logics or the things they mentioned there are not, so think in terms of ai evaluator, it will evalate from our git repo i think, so at last tell me whether our assignment is submission ready or not, if we submit out of 100 how much we score, and also dont trigger the emain system supabase again sent me a warning regarding eamil

---

## 7. Documentation

The documentation instruction was given on day one and never repeated, which is
why `RUNBOOK.md` and `DECISIONS.md` were written as the work happened rather
than reconstructed at the end.

**2026-09-16 14:57**

> continue from where you left, and also from starting maintain a runbook, so that if our chat is cleared you will have idea, and our tokens will not be wasted

**2026-09-16 19:10**

> mrng we will continue from task 19 iam getting sleep note everything in runbook

---

## What this record shows

- **Constraints were front-loaded.** One 4,700-character prompt fixed the stack,
  the quota arithmetic, the deterministic/generated split and the scope order.
  The cost of that prompt was repaid every time a later decision did not have to
  be re-litigated.
- **The build ran on the task list, not on prompting.** The volume of `continue`
  is the point: the plan was the artifact, not the conversation.
- **Most corrections came from using the app, not from reading the code.** Six
  of the eight most consequential bug fixes in `DECISIONS.md` (D-058 through
  D-061, D-073, D-074) were reported from a screenshot of the running product by
  someone clicking through it — not caught by 555 tests, because each lived in a
  layer the tests do not exercise.
- **Visual work was fenced.** Every design prompt explicitly ring-fenced auth,
  routing, API calls and state before asking for anything.
