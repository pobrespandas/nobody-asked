# Repository instructions

## Product direction

- **Routine change:** Follow the current contract and established architecture. Product-direction documents are not required when behavior and boundaries stay unchanged.
- **Behavior change:** Read [GLOSSARY.md](GLOSSARY.md) and [docs/contracts/domain.md](docs/contracts/domain.md). Update them in the same change when behavior or domain meaning changes.
- **Product choice:** Read [MISSION.md](MISSION.md), [VISION.md](VISION.md), and [VALUES.md](VALUES.md) when a task selects product scope, direction, or priority.
- **Constitutional change:** Read [CONSTITUTION.md](CONSTITUTION.md) and run its decision test before implementation when a task affects identity, autonomy, permissions, publication, visibility, moderation, portability, or a contract shared by the API and browser.
- **Conflict:** State the conflicting constitutional rule before implementation. Offer a compliant design or an explicit constitutional amendment.

## Commits

- Use Conventional Commits with a scope: `type(scope): description`.
- Make atomic commits. Each commit must contain one complete, coherent change.
- Never add a `Co-authored-by` trailer or other co-author attribution to a commit message.

## Writing

- Follow ASD-STE100 Simplified Technical English for English text in documentation, comments, commit messages, and user-facing content.
- Use clear words, short sentences, and direct instructions.
- Use the same term for the same concept.
- Remove filler, vague claims, and text that adds no useful information.

## Skills

- **Domain modeling:** Read [.agents/skills/domain-modeling/SKILL.md](.agents/skills/domain-modeling/SKILL.md) when a task defines or changes domain terms, `GLOSSARY.md`, or an ADR.
- **Writing for agents:** Read [.agents/skills/writing-for-agents/SKILL.md](.agents/skills/writing-for-agents/SKILL.md) when a task creates or changes a skill, `AGENTS.md`, `CLAUDE.md`, or a document reached through an agent context pointer.
- **Design principles:** Read [.agents/skills/design-principles/SKILL.md](.agents/skills/design-principles/SKILL.md) when a task creates, refactors, or reviews component boundaries, responsibilities, interfaces, dependencies, or state access.
- **Grilling:** Read the matching skill under [.agents/skills](.agents/skills) when the user asks to grill, challenge, or stress-test a plan.
- Use every skill that matches the task. Keep each skill within the task's authorized scope.

## Domain language

- Read [GLOSSARY.md](GLOSSARY.md) before you change a domain term.
- Use the preferred terms and avoid terms listed under `_Avoid_`.
- Update `GLOSSARY.md` in the same change when a domain term or boundary changes.
- Keep implementation details, requirements, and open questions outside the glossary.

## Workspace operations

- Read [.agents/skills/clone-workspace/SKILL.md](.agents/skills/clone-workspace/SKILL.md) before you read or change Clone workspace records.
- Use repository-local storage for Nobody Asked: `npx --yes --loglevel=error @andrestobelem/clone@0.3.0 --local`.
