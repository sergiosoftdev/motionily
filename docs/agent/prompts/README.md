# Prompts

Every instruction Motionily gives a model lives in `docs/agent`. The code only assembles these files; it never
writes guidance of its own. One rule, one place: when two prompts disagree, Claude picks one at random, and that is
how AI slop and weak structure get back in.

## Where a rule goes

| What | File |
| --- | --- |
| Craft for every video: motion, color, type, the short-form attention curve, the voice-over script, AI tells | `../craft.md` (sections `## …`) |
| Professional 2D motion: genres, recipes | `../motion-2d.md` |
| Layer syntax, camera math | `../syntax.md` |
| Workflow, tools, ops | `../manual.md` |
| A role's job: its steps, its tools, its answer format | `prompts/<role>.md` |

A role prompt says WHAT the role does and in which order; it never restates a craft rule. It points to the section
instead ("the voice-over follows craft: VOICE-OVER SCRIPT") and includes the doc it needs.

Brand notes (the brand kit, in the database) describe the brand: audience, language, tone, identity. They never
carry craft or structure rules; when they do, craft wins.

## Files

| File | Who reads it |
| --- | --- |
| `concepts.md` + `story-short-form.md` / `story-classic.md` | the concept pitch (new video wizard) |
| `planner.md`, `builder.md`, `finisher.md` | the team that builds a video in parallel |
| `agent.md` + `solo-steps.md` | one agent building the whole video |
| `sound.md` | the sound designer pass |
| `footage.md` | the editor of the user's own clips |
| `continue.md` | resuming an interrupted run |
| `no-probing.md` | included by every builder role |
| `copywriter.md` | post captions and hashtags |
| `suno.md` | the music prompt for Suno |
| `mcp.md`, `mcp-account.md` | the MCP server's instructions to outside agents |

## Syntax

- `{{include:craft.md}}` pastes a whole doc (paths from `docs/agent`).
- `{{include:craft.md#SHORT-FORM ATTENTION CURVE}}` pastes one `## SHORT-FORM ATTENTION CURVE` section.
- `{{name}}` is a value the code passes (`{{max_beats}}`, `{{devices}}`).

The loader throws at start-up on an unknown name or a missing section, so a typo never ships a prompt with a hole.
