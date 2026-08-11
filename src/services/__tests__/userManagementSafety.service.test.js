import test from "node:test"
import assert from "node:assert/strict"

import {
  deleteManagedUser,
  updateManagedUser,
} from "../../routes/system.routes.js"

const createDb = ({
  targetUser,
  activeItSupportCount = 2,
} = {}) => {
  const calls = {
    count: 0,
    updates: [],
    deletes: [],
    isolationLevel: null,
  }
  const tx = {
    user: {
      findUnique: async () => targetUser,
      count: async () => {
        calls.count += 1
        return activeItSupportCount
      },
      update: async ({ data }) => {
        calls.updates.push(data)
        return { ...targetUser, ...data }
      },
      delete: async ({ where }) => {
        calls.deletes.push(where.id)
        return targetUser
      },
    },
    activityLog: { deleteMany: async () => ({ count: 0 }) },
    userInvite: { deleteMany: async () => ({ count: 0 }) },
  }
  return {
    calls,
    db: {
      $transaction: async (operation, options) => {
        calls.isolationLevel = options?.isolationLevel
        return operation(tx)
      },
    },
  }
}

const itSupport = (overrides = {}) => ({
  id: 1,
  name: "Admin",
  email: "admin@example.test",
  role: "it_support",
  isActive: true,
  ...overrides,
})

test("IT Support cannot deactivate, demote, or delete their own account", async () => {
  for (const [operation, errorCode] of [
    [
      (db) => updateManagedUser({
        db,
        actorUserId: 1,
        targetUserId: 1,
        updateData: { isActive: false },
      }),
      "SELF_DEACTIVATION_NOT_ALLOWED",
    ],
    [
      (db) => updateManagedUser({
        db,
        actorUserId: 1,
        targetUserId: 1,
        updateData: { role: "operational" },
      }),
      "SELF_ROLE_DOWNGRADE_NOT_ALLOWED",
    ],
    [
      (db) => deleteManagedUser({
        db,
        actorUserId: 1,
        targetUserId: 1,
      }),
      "SELF_DELETION_NOT_ALLOWED",
    ],
  ]) {
    const { db, calls } = createDb({ targetUser: itSupport() })
    await assert.rejects(() => operation(db), (error) => error.errorCode === errorCode)
    assert.deepEqual(calls.updates, [])
    assert.deepEqual(calls.deletes, [])
  }
})

test("the last active IT Support cannot be deactivated, demoted, or deleted", async () => {
  for (const operation of [
    (db) => updateManagedUser({
      db,
      actorUserId: 9,
      targetUserId: 1,
      updateData: { isActive: false },
    }),
    (db) => updateManagedUser({
      db,
      actorUserId: 9,
      targetUserId: 1,
      updateData: { role: "management" },
    }),
    (db) => deleteManagedUser({
      db,
      actorUserId: 9,
      targetUserId: 1,
    }),
  ]) {
    const { db, calls } = createDb({
      targetUser: itSupport(),
      activeItSupportCount: 1,
    })
    await assert.rejects(
      () => operation(db),
      (error) => error.errorCode === "LAST_IT_SUPPORT_REQUIRED"
    )
    assert.deepEqual(calls.updates, [])
    assert.deepEqual(calls.deletes, [])
  }
})

test("another IT Support may remove access when another active administrator remains", async () => {
  const deactivate = createDb({
    targetUser: itSupport({ id: 2 }),
    activeItSupportCount: 2,
  })
  const deactivated = await updateManagedUser({
    db: deactivate.db,
    actorUserId: 1,
    targetUserId: 2,
    updateData: { isActive: false },
  })
  assert.equal(deactivated.isActive, false)
  assert.equal(deactivate.calls.count, 1)
  assert.equal(deactivate.calls.isolationLevel, "Serializable")

  const demote = createDb({
    targetUser: itSupport({ id: 2 }),
    activeItSupportCount: 2,
  })
  const demoted = await updateManagedUser({
    db: demote.db,
    actorUserId: 1,
    targetUserId: 2,
    updateData: { role: "operational" },
  })
  assert.equal(demoted.role, "operational")

  const remove = createDb({
    targetUser: itSupport({ id: 2 }),
    activeItSupportCount: 2,
  })
  await deleteManagedUser({
    db: remove.db,
    actorUserId: 1,
    targetUserId: 2,
  })
  assert.deepEqual(remove.calls.deletes, [2])
})

test("safe self-profile updates and updates to non-admin users remain allowed", async () => {
  const self = createDb({ targetUser: itSupport() })
  const updatedSelf = await updateManagedUser({
    db: self.db,
    actorUserId: 1,
    targetUserId: 1,
    updateData: { name: "Updated Admin" },
  })
  assert.equal(updatedSelf.name, "Updated Admin")
  assert.equal(self.calls.count, 0)

  const operational = createDb({
    targetUser: itSupport({
      id: 3,
      role: "operational",
    }),
    activeItSupportCount: 1,
  })
  const deactivated = await updateManagedUser({
    db: operational.db,
    actorUserId: 1,
    targetUserId: 3,
    updateData: { isActive: false },
  })
  assert.equal(deactivated.isActive, false)
  assert.equal(operational.calls.count, 0)
})
