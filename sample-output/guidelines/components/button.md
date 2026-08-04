# Button

> Component set · 176 variants · in `Actions`

_Primary interactive control._

## Variants and properties

| Property | Type | Options | Default | Notes |
|---|---|---|---|---|
| `Type` | VARIANT | `Primary - brand`, `Primary - buy`, `Secondary - grey`, `Tertiary` | `Primary - brand` | — |
| `Size` | VARIANT | `28`, `36`, `40`, `48` | `36` | — |
| `State` | VARIANT | `Default`, `Hover`, `Pressed`, `Disabled` | `Default` | — |
| `IconLeading` | BOOLEAN | — | `false` | Shows the leading icon slot. |
| `Label` | TEXT | — | `Button` | — |

Nests: `Icon`

## Purpose

- The primary interactive control. Every action a user can take is a Button.

## When to use

- Use whenever the user commits to something — submitting, confirming, triggering. Never build a bare HTML button.

## Use instead

- For navigation that changes the URL, use `Link`. For an action on a single row or cell, use `Icon button`.

## Pairs with

- Inside a `Button group` when there is more than one action — gap 8px, never hand-spaced.

## States

- Disabled must be paired with a tooltip explaining why. A button that triggers a request shows the loading state, never a spinner placed next to it.

## Content and wording

- Sentence case, verb first, three words maximum. "Save changes", not "Submit" and not "Save Changes".

## Rules

- Only one `Primary - brand` button per visible section.
- All buttons in a group must share the same Size. Do not mix 36 and 40.
- Use `Primary - buy` / `Primary - sell` only inside trading flows.

## Don't

- Do not use Tertiary for a destructive action — it reads as a link.

## Notes

- State is driven by the interaction-alias variable mode; the layer structure is identical across all four states.
