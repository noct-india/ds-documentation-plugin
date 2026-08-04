# Collection: Primitive Colors

> Variable collection · 3 variables

## Modes

- `Light`
- `Dark`

## Structure

```
neutral/
  1000
  900
brand/
  blue-500
```

## Purpose

- Raw palette. Never referenced directly by a designer or a developer — always go through a semantic alias in `Color - General alias`.

## Modes

- Light is the source of truth. Dark is derived and must preserve the same contrast rank — if a token is the darkest neutral in Light, it is the lightest in Dark.

## Naming convention

- `family/weight` — weight runs 100 (lightest) to 1000 (darkest) in Light mode. The number describes position in the ramp, not lightness, so it stays stable across modes.

## Rules

- Every primitive must have at least one semantic alias pointing at it. An unaliased primitive is dead weight.

## Don't

- Do not add a new primitive to solve a one-off. Add a semantic alias to an existing one instead.

## Variables

### Variable: neutral/1000

> COLOR · in `Primitive Colors`

## Values by mode

| Mode | Value |
|---|---|
| Light | `#0A0A0A` |
| Dark | `#FAFAFA` |

#### Purpose

- The darkest neutral. Provides maximum contrast for text, icons and borders while staying visually neutral — no blue, green or warm tint.

#### When to use

- Use wherever maximum readability and hierarchy are required — primary body text, headings, high-emphasis icons.

#### Use instead

- For secondary or supporting text use `neutral/700`. For anything on a coloured surface use `content/on-brand`.

#### Don't

- Never reference this hex directly. Consumers use the semantic token `content/primary`.

### Variable: brand/blue-500

> COLOR · in `Primitive Colors`

## Values by mode

| Mode | Value |
|---|---|
| Light | `#2D6BFF` |
| Dark | `#5B8CFF` |

#### Rules

- Brand blue is an accent. Never use it as a background for cards, panels or large areas.
