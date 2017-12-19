"use strict";

const express = require('express');
const router = express.Router();
const sql = require('../../services/sql');
const utils = require('../../services/utils');
const auth = require('../../services/auth');
const sync_table = require('../../services/sync_table');

router.put('/:noteTreeId/move-to/:parentNoteId', auth.checkApiAuth, async (req, res, next) => {
    const noteTreeId = req.params.noteTreeId;
    const parentNoteId = req.params.parentNoteId;
    const sourceId = req.headers.source_id;

    const maxNotePos = await sql.getSingleValue('SELECT MAX(note_pos) FROM notes_tree WHERE note_pid = ? AND is_deleted = 0', [parentNoteId]);
    const newNotePos = maxNotePos === null ? 0 : maxNotePos + 1;

    const now = utils.nowDate();

    await sql.doInTransaction(async () => {
        await sql.execute("UPDATE notes_tree SET note_pid = ?, note_pos = ?, date_modified = ? WHERE note_tree_id = ?",
            [parentNoteId, newNotePos, now, noteTreeId]);

        await sync_table.addNoteTreeSync(noteTreeId, sourceId);
    });

    res.send({});
});

router.put('/:noteTreeId/move-before/:beforeNoteTreeId', async (req, res, next) => {
    const noteTreeId = req.params.noteTreeId;
    const beforeNoteTreeId = req.params.beforeNoteTreeId;
    const sourceId = req.headers.source_id;

    const beforeNote = await sql.getSingleResult("SELECT * FROM notes_tree WHERE note_tree_id = ?", [beforeNoteTreeId]);

    if (beforeNote) {
        await sql.doInTransaction(async () => {
            // we don't change date_modified so other changes are prioritized in case of conflict
            // also we would have to sync all those modified note trees otherwise hash checks would fail
            await sql.execute("UPDATE notes_tree SET note_pos = note_pos + 1 WHERE note_pid = ? AND note_pos >= ? AND is_deleted = 0",
                [beforeNote.note_pid, beforeNote.note_pos]);

            await sync_table.addNoteReorderingSync(beforeNote.note_pid, sourceId);

            const now = utils.nowDate();

            await sql.execute("UPDATE notes_tree SET note_pid = ?, note_pos = ?, date_modified = ? WHERE note_tree_id = ?",
                [beforeNote.note_pid, beforeNote.note_pos, now, noteTreeId]);

            await sync_table.addNoteTreeSync(noteTreeId, sourceId);
        });

        res.send({});
    }
    else {
        res.status(500).send("Before note " + beforeNoteTreeId + " doesn't exist.");
    }
});

router.put('/:noteTreeId/move-after/:afterNoteTreeId', async (req, res, next) => {
    const noteTreeId = req.params.noteTreeId;
    const afterNoteTreeId = req.params.afterNoteTreeId;
    const sourceId = req.headers.source_id;

    const afterNote = await sql.getSingleResult("SELECT * FROM notes_tree WHERE note_tree_id = ?", [afterNoteTreeId]);

    if (afterNote) {
        await sql.doInTransaction(async () => {
            // we don't change date_modified so other changes are prioritized in case of conflict
            // also we would have to sync all those modified note trees otherwise hash checks would fail
            await sql.execute("UPDATE notes_tree SET note_pos = note_pos + 1 WHERE note_pid = ? AND note_pos > ? AND is_deleted = 0",
                [afterNote.note_pid, afterNote.note_pos]);

            await sync_table.addNoteReorderingSync(afterNote.note_pid, sourceId);

            await sql.execute("UPDATE notes_tree SET note_pid = ?, note_pos = ?, date_modified = ? WHERE note_tree_id = ?",
                [afterNote.note_pid, afterNote.note_pos + 1, utils.nowDate(), noteTreeId]);

            await sync_table.addNoteTreeSync(noteTreeId, sourceId);
        });

        res.send({});
    }
    else {
        res.status(500).send("After note " + afterNoteTreeId + " doesn't exist.");
    }
});

router.put('/:childNoteId/clone-to/:parentNoteId', auth.checkApiAuth, async (req, res, next) => {
    const parentNoteId = req.params.parentNoteId;
    const childNoteId = req.params.childNoteId;
    const sourceId = req.headers.source_id;

    const existing = await sql.getSingleValue('SELECT * FROM notes_tree WHERE note_id = ? AND note_pid = ?', [childNoteId, parentNoteId]);

    if (existing && !existing.is_deleted) {
        return res.send({
            success: false,
            message: 'This note already exists in target parent note.'
        });
    }

    if (!await checkCycle(parentNoteId, childNoteId)) {
        return res.send({
            success: false,
            message: 'Cloning note here would create cycle.'
        });
    }

    const maxNotePos = await sql.getSingleValue('SELECT MAX(note_pos) FROM notes_tree WHERE note_pid = ? AND is_deleted = 0', [parentNoteId]);
    const newNotePos = maxNotePos === null ? 0 : maxNotePos + 1;

    await sql.doInTransaction(async () => {
        const noteTree = {
            note_tree_id: utils.newNoteTreeId(),
            note_id: childNoteId,
            note_pid: parentNoteId,
            note_pos: newNotePos,
            is_expanded: 0,
            date_modified: utils.nowDate(),
            is_deleted: 0
        };

        await sql.replace("notes_tree", noteTree);

        await sync_table.addNoteTreeSync(noteTree.note_tree_id, sourceId);
    });

    res.send({
        success: true
    });
});

router.put('/:noteId/clone-after/:afterNoteTreeId', async (req, res, next) => {
    const noteId = req.params.noteId;
    const afterNoteTreeId = req.params.afterNoteTreeId;
    const sourceId = req.headers.source_id;

    const afterNote = await sql.getSingleResult("SELECT * FROM notes_tree WHERE note_tree_id = ?", [afterNoteTreeId]);

    if (!afterNote) {
        return res.status(500).send("After note " + afterNoteTreeId + " doesn't exist.");
    }

    if (!await checkCycle(afterNote.note_pid, noteId)) {
        return res.send({
            success: false,
            message: 'Cloning note here would create cycle.'
        });
    }

    const existing = await sql.getSingleValue('SELECT * FROM notes_tree WHERE note_id = ? AND note_pid = ?', [noteId, afterNote.note_pid]);

    if (existing && !existing.is_deleted) {
        return res.send({
            success: false,
            message: 'This note already exists in target parent note.'
        });
    }

    await sql.doInTransaction(async () => {
        // we don't change date_modified so other changes are prioritized in case of conflict
        // also we would have to sync all those modified note trees otherwise hash checks would fail
        await sql.execute("UPDATE notes_tree SET note_pos = note_pos + 1 WHERE note_pid = ? AND note_pos > ? AND is_deleted = 0",
            [afterNote.note_pid, afterNote.note_pos]);

        await sync_table.addNoteReorderingSync(afterNote.note_pid, sourceId);

        const noteTree = {
            note_tree_id: utils.newNoteTreeId(),
            note_id: noteId,
            note_pid: afterNote.note_pid,
            note_pos: afterNote.note_pos + 1,
            is_expanded: 0,
            date_modified: utils.nowDate(),
            is_deleted: 0
        };

        await sql.replace("notes_tree", noteTree);

        await sync_table.addNoteTreeSync(noteTree.note_tree_id, sourceId);
    });

    res.send({
        success: true
    });
});

async function checkCycle(parentNoteId, childNoteId) {
    if (parentNoteId === 'root') {
        return true;
    }

    if (parentNoteId === childNoteId) {
        return false;
    }

    const parentNoteIds = await sql.getFlattenedResults("SELECT DISTINCT note_pid FROM notes_tree WHERE note_id = ?", [parentNoteId]);

    for (const pid of parentNoteIds) {
        if (!await checkCycle(pid, childNoteId)) {
            return false;
        }
    }

    return true;
}

router.put('/:noteTreeId/expanded/:expanded', async (req, res, next) => {
    const noteTreeId = req.params.noteTreeId;
    const expanded = req.params.expanded;

    await sql.doInTransaction(async () => {
        await sql.execute("UPDATE notes_tree SET is_expanded = ? WHERE note_tree_id = ?", [expanded, noteTreeId]);

        // we don't sync expanded attribute
    });

    res.send({});
});

module.exports = router;