# Athlete Dashboard Data Contract

This contract defines how `AthleteDashboard.jsx` fields map to the existing Supabase schema with additive changes.

## Module Keys

Supported unlock keys:

- `pre-screen`
- `food-preferences`
- `mission-1-v1`
- `mission-1-v23`
- `mission-2-v1`
- `mission-2-v23`
- `mission-3-v1`
- `mission-3-v23`
- `mission-4-v1`
- `mission-4-v23`
- `mission-5-v1`
- `mission-5-v23`
- `training-planner`
- `game-day-planner`
- `shopping-list`

## Entity Mapping

- `athlete.id` -> `students.id`
- `athlete.firstName` -> `students.first_name`
- `athlete.lastName` -> `students.last_name`
- `athlete.email` -> `students.email`
- `unlocks[]` -> `student_unlocks.module_key`
- `foodPreferences.selections` -> `student_food_preferences.selections`
- `foodPreferences.completedAt` -> `student_food_preferences.completed_at`

## API Payload Shapes

### POST `/api/auth/signup`

Request:

```json
{
  "firstName": "Jake",
  "lastName": "Taufa",
  "email": "jake@email.com",
  "password": "string-min-8"
}
```

Response:

```json
{
  "athlete": {
    "id": "uuid",
    "firstName": "Jake",
    "lastName": "Taufa",
    "email": "jake@email.com"
  },
  "token": "opaque-session-token"
}
```

### POST `/api/auth/login`

Request:

```json
{
  "email": "jake@email.com",
  "password": "string"
}
```

Response:

```json
{
  "athlete": {
    "id": "uuid",
    "firstName": "Jake",
    "lastName": "Taufa",
    "email": "jake@email.com"
  },
  "token": "opaque-session-token"
}
```

### GET `/api/athlete/me`

Headers:

- `Authorization: Bearer <token>`

Response:

```json
{
  "athlete": {
    "id": "uuid",
    "firstName": "Jake",
    "lastName": "Taufa",
    "email": "jake@email.com"
  },
  "unlocks": ["pre-screen", "food-preferences"]
}
```

### POST `/api/athlete/unlock`

Request:

```json
{
  "moduleKey": "mission-1-v1"
}
```

Response:

```json
{
  "moduleKey": "mission-1-v1",
  "unlockedAt": "2026-04-16T00:00:00.000Z"
}
```

### GET `/api/athlete/food-prefs`

Response:

```json
{
  "selections": {
    "cereals": ["weet-bix", "oats"]
  },
  "completedAt": "2026-04-16T00:00:00.000Z"
}
```

### POST `/api/athlete/food-prefs`

Request:

```json
{
  "selections": {
    "cereals": ["weet-bix", "oats"]
  },
  "completedAt": "2026-04-16T00:00:00.000Z"
}
```

Response:

```json
{
  "ok": true
}
```
