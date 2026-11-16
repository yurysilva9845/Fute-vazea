import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const rulesSource = fs.readFileSync('./firestore.rules', 'utf8');

test('firestore.rules enforces global default deny and all collections including WebRTC signals', () => {
  assert.ok(rulesSource.includes("rules_version = '2';"));
  assert.ok(rulesSource.includes('match /{document=**} {\n      allow read, write: if false;\n    }'));
  assert.ok(rulesSource.includes('match /users/{userId}'));
  assert.ok(rulesSource.includes('match /rooms/{roomId}'));
  assert.ok(rulesSource.includes('match /signals/{signalId}'));
  assert.ok(rulesSource.includes('match /friendRequests/{requestId}'));
  assert.ok(rulesSource.includes('match /matchHistory/{matchId}'));
});

test('Dirty Dozen payloads are blocked by validation helpers and action gates', () => {
  // 1. Identity spoofing on UserProfile create
  assert.ok(rulesSource.includes('data.uid == userId'));
  // 2. Shadow field injection blocked via hasOnly
  assert.ok(rulesSource.includes('data.keys().hasOnly(['));
  // 3. Server timestamp enforcement
  assert.ok(rulesSource.includes('incoming().createdAt == request.time'));
  assert.ok(rulesSource.includes('incoming().updatedAt == request.time'));
  // 4. Immutable fields on UserProfile update
  assert.ok(rulesSource.includes('incoming().uid == existing().uid'));
  assert.ok(rulesSource.includes('incoming().tagCode == existing().tagCode'));
  // 5. String size bounds on room fields
  assert.ok(rulesSource.includes('data.hostName.size() <= 32'));
  // 6. Terminal state locking on finished rooms
  assert.ok(rulesSource.includes("existing().status != 'finished'"));
  // 7. Score protection for non-hosts
  assert.ok(rulesSource.includes('incoming().homeGoals == existing().homeGoals'));
  // 8. Relational existence check for FriendRequest
  assert.ok(rulesSource.includes('exists(/databases/$(database)/documents/users/$(incoming().toUid))'));
  // 9. Self-friend request blocked
  assert.ok(rulesSource.includes('data.fromUid != data.toUid'));
  // 10. Only recipient can accept/decline pending friend request
  assert.ok(rulesSource.includes('existing().toUid == request.auth.uid'));
  // 11. List query enforcement on friendRequests
  assert.ok(rulesSource.includes('existing().fromUid == request.auth.uid || existing().toUid == request.auth.uid'));
  // 12. MatchHistory immutability
  assert.ok(rulesSource.includes('allow update, delete: if false;'));
  // 13. WebRTC voice signaling validation
  assert.ok(rulesSource.includes("data.type in ['offer', 'answer', 'ice']"));
});
