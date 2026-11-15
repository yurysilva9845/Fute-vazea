# Security Specification — Várzea Raiz 4x4

## 1. Data Invariants

1. **Zero PII Invariant**: `/users/{userId}` stores strictly public game profile attributes (`uid`, `displayName`, `tagCode`, `favoritePlayer`, `wins`, `losses`, `draws`, `goalsScored`, `onlineStatus`, `currentRoomCode`, `createdAt`, `updatedAt`). No email, phone, or physical address is stored.
2. **Profile Ownership Invariant**: A `/users/{userId}` document can only be created or updated by `request.auth.uid == userId`, with `incoming().uid == request.auth.uid` and immutable `createdAt` / `uid` / `tagCode`.
3. **Room Authority & Terminal State Invariant**: A `/rooms/{roomId}` document is created by an authenticated host (`incoming().hostUid == request.auth.uid`). Once `existing().status == 'finished'`, no further updates are permitted (Terminal State Locking).
4. **Friend Request Relational Invariant**: A `/friendRequests/{requestId}` document can only be created if `incoming().fromUid == request.auth.uid`, `incoming().toUid != request.auth.uid`, and both `/users/$(incoming().fromUid)` and `/users/$(incoming().toUid)` exist. List queries on `/friendRequests` must filter by `resource.data.fromUid == request.auth.uid || resource.data.toUid == request.auth.uid`.
5. **Match History Immutability Invariant**: A `/matchHistory/{matchId}` document can only be created by `incoming().recordedByUid == request.auth.uid` with `incoming().createdAt == request.time`, and can never be modified or deleted once created.

## 2. The "Dirty Dozen" Payloads (Designed to Break Identity, Integrity, and State)

1. **Identity Spoofing on User Profile Create**: Authenticated user `user_A` attempts to create `/users/user_B` with `uid: "user_B"`. -> `PERMISSION_DENIED`.
2. **Shadow Field Injection on User Profile**: `user_A` sends valid profile fields plus `"isAdmin": true`. -> `PERMISSION_DENIED` via `.keys().hasOnly(...)`.
3. **Client Timestamp Forgery on User Create**: `user_A` sets `createdAt` to a past timestamp instead of `request.time`. -> `PERMISSION_DENIED`.
4. **Immutable Field Mutation on User Update**: `user_A` attempts to change `createdAt` or `uid` during an update. -> `PERMISSION_DENIED`.
5. **Oversized String DoW Attack on Room Create**: `user_A` sends a 5,000-character `hostName` or `roomCode` to `/rooms/ROOM1`. -> `PERMISSION_DENIED`.
6. **Terminal State Bypass on Finished Room**: `user_A` attempts to update `homeGoals` on a room where `existing().status == 'finished'`. -> `PERMISSION_DENIED`.
7. **Unauthorized Score Manipulation on Room**: Non-host `user_B` attempts to update `homeGoals` or `awayGoals` while `hostUid` is `user_A`. -> `PERMISSION_DENIED`.
8. **Orphaned Friend Request to Non-Existent User**: `user_A` creates a friend request where `toUid: "ghost_user"` does not exist in `/users/ghost_user`. -> `PERMISSION_DENIED`.
9. **Self-Friend Request**: `user_A` sends a friend request with `fromUid == toUid`. -> `PERMISSION_DENIED`.
10. **Unauthorized Friend Request Acceptance**: `user_A` (the sender, not the recipient `toUid`) attempts to update `status` from `'pending'` to `'accepted'`. -> `PERMISSION_DENIED`.
11. **Unbounded List Scraping on Friend Requests**: `user_C` attempts an unfiltered `list` on `/friendRequests` where `user_C` is neither `fromUid` nor `toUid`. -> `PERMISSION_DENIED`.
12. **History Tampering**: `user_A` attempts to `update` or `delete` a completed `/matchHistory/{matchId}` document. -> `PERMISSION_DENIED`.
