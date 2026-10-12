// artifickoi StatusMenu Engine
// Version: `const ENGINE_VERSION` below — the ONE place it is written. Bump it on every change.
// It is REPORTED, displayed and logged, never COMPARED: mvu-helper reads it off this module when
// the engine is loaded, and off this declaration line when validating an artifact that is not
// running yet. Nothing gates on it.
// The display half of the School v4 GameLogic Engine: formatters read, actions write, inputs say
// what an action needs — nothing else. Formatters are (stat, root, scopePath) => value and PURE:
// `stat` is the raw value at `scopePath` — the item a collection block is drawing (`Classmate.Airi`),
// the object a block is mapped to, or the whole state outside every block — and `root` the whole
// stat_data. The formatters the layout's cell formulas compute are NOT written here: they live in
// layoutFormatters.cjs, which MvuStatMenuBuilder rewrites on every layout export and which loads
// before this file (pack.json engineOrder), and they arrive as LAYOUT_FORMATTERS. A formatter written
// by hand goes in HAND_FORMATTERS below. Actions are (args, root) =>
// patches — `args` is what the menu posted (a click's own observations: paths, keys, the form's
// strings) and every judgment about what the write MEANS is made here, against this game's own
// tables, never in the menu runtime. Inputs are (args, root) => [{ name, kind, label, options }],
// asked at click time for the verbs that need a choice, so the menu never holds a list of who can
// receive what — it draws whatever this file answers.
const ENGINE_VERSION = 'v1.7';

const isTuple = (v) => Array.isArray(v) && v.length >= 2 && typeof v[1] === 'string';

const getRaw = (obj, path, def) => {
    if (!obj) return def;
    if (!path) return obj;
    let cur = obj;
    for (const seg of String(path).split('.')) {
        if (cur === undefined || cur === null) return def;
        cur = cur[seg];
    }
    return (cur === undefined || cur === null) ? def : cur;
};

const getV = (obj, path, def) => {
    const val = getRaw(obj, path, def);
    return isTuple(val) ? val[0] : val;
};

const getL = (obj, path, def) => {
    const val = getRaw(obj, path, def);
    return isTuple(val) ? val[1] : def;
};

// A `set` patch for ONE member, given its bare value. A patch replaces the WHOLE member, so a
// [value, label] pair keeps its label here — a bare value written over a labelled member is a shape
// change the card's schema refuses while the old value stays. Every set goes through it.
const setPatch = (root, path, value) => {
    const label = getL(root, path, null);
    return { op: 'set', path, value: label === null ? value : [value, label] };
};

// A `set` patch for a member that is ALWAYS a [value, label] pair in this card's schema: an existing
// pair keeps its label, anything else becomes [value, defaultLabel].
const tuplePatch = (root, path, value, defaultLabel) => {
    const label = getL(root, path, null);
    return { op: 'set', path, value: [value, label === null ? defaultLabel : label] };
};

// ── School's own tables — the vocabulary the menu runtime must never carry ───────────────────────

// Field types per list, keyed by the list's path with a classmate key wildcarded (`Classmate.*.X`).
// A field not listed is a string; a list not listed cannot be edited from the menu (refused by name).
// Source: statdata_schema.txt.
const LIST_FIELD_TYPES = {
    'Mainchar.Quests':              { Step: 'number' },
    'Mainchar.Skills':              {},
    'Mainchar.Belongings':          { Qty: 'number' },
    'Mainchar.Inventory':           { Qty: 'number' },
    'WorldRecord.Locations':        {},
    'WorldRecord.Events':           {},
    'WorldRecord.NPCs':             {},
    'Classmate.*.ImportantEvents':  {},
    'Classmate.*.Friends':          {},
    'Classmate.*.Hobbies':          {},
    'Classmate.*.Belongings':       { Qty: 'number' },
};

// Where a character keeps what they carry (`<char>.Belongings`), and the one inventory items return
// to. School has no slots, no limits and no stat bonuses: to "equip" is to carry.
const CARRIED_LEAF = 'Belongings';
const INVENTORY_PATH = 'Mainchar.Inventory';

// The game-start screen (regex/_GameStartMenu__.json): the four identity fields it asks for, and the
// stat budget it hands out. The form keeps its own copy of the budget for live feedback while the
// player spends points; THIS copy is the one the write is held to, so a post the form let through and
// this refuses comes back as this refusal, by name, on the form's status line.
const START_IDENTITY = [['name', 'Name'], ['age', 'Age'], ['gender', 'Gender'], ['race', 'Race']];
const START_POINTS = 200;
const START_STAT_MAX = 100;
const START_STAT_MIN = { Str: 0, Sta: 30, Int: 0, Cha: 0 };
const START_STAT_LABEL = { Str: 'Strength', Sta: 'Stamina', Int: 'Intelligence', Cha: 'Charisma' };
const isTrueFlag = (v) => { const raw = isTuple(v) ? v[0] : v; return raw === true || raw === 1 || raw === 'true'; };

// ── helpers for the write half ───────────────────────────────────────────────────────────────────

const listPattern = (listPath) => {
    const parts = String(listPath || '').split('.');
    return parts[0] === 'Classmate' && parts.length === 3 ? 'Classmate.*.' + parts[2] : String(listPath || '');
};

const fieldKind = (listPath, field) => {
    const table = LIST_FIELD_TYPES[listPattern(listPath)];
    if (!table) throw new Error('no field table for list "' + listPath + '" — this menu cannot edit it');
    return table[field] || 'string';
};

// The typed value of one form string, by the table's kind. A string that is not what the kind
// demands refuses the whole edit, naming the field.
const typeField = (kind, text, field) => {
    const s = text === undefined || text === null ? '' : String(text);
    switch (kind) {
        case 'number': {
            if (s.trim() === '' || Number.isNaN(Number(s))) throw new Error('field "' + field + '" must be a number, got ' + JSON.stringify(s));
            return Number(s);
        }
        case 'boolean': {
            if (s === 'true') return true;
            if (s === 'false') return false;
            throw new Error('field "' + field + '" must be true or false, got ' + JSON.stringify(s));
        }
        case 'json': {
            try { return JSON.parse(s); }
            catch (e) { throw new Error('field "' + field + '" must be JSON: ' + e.message); }
        }
        default:
            return s;
    }
};

const isPlainObject = (v) => !!v && typeof v === 'object' && !Array.isArray(v);

const requireContainer = (root, path, what) => {
    const obj = getRaw(root, path, null);
    if (!isPlainObject(obj)) throw new Error(what + ' "' + path + '" is not a list in this state');
    return obj;
};

const requireItem = (root, listPath, itemKey, what) => {
    const list = requireContainer(root, listPath, what);
    if (!Object.prototype.hasOwnProperty.call(list, String(itemKey))) {
        throw new Error('"' + itemKey + '" is not in ' + what + ' "' + listPath + '"');
    }
    return list[String(itemKey)];
};

const sameValue = (a, b) => JSON.stringify(a) === JSON.stringify(b);

const requireString = (args, name) => {
    if (typeof args[name] !== 'string' || !args[name]) throw new Error('args.' + name + ' must be a non-empty string');
    return args[name];
};

// Formatters written by hand, beside the layout's. A name the layout also computes is refused when the
// engine loads: two definitions of one cell's formatter would leave one of them silently dead.
const HAND_FORMATTERS = {
};
for (const name of Object.keys(HAND_FORMATTERS)) {
    if (Object.prototype.hasOwnProperty.call(LAYOUT_FORMATTERS, name)) {
        throw new Error('formatter "' + name + '" is written by hand in statusMenuLogic.cjs AND computed by the layout (layoutFormatters.cjs) — rename the hand-written one');
    }
}

module.exports = {
    ENGINE_VERSION,
    formatters: { ...LAYOUT_FORMATTERS, ...HAND_FORMATTERS },

    // The menu actions (pack-authoring-plan §B.7e.4) and the game-start screen's one. Each returns an ARRAY of
    // { op: 'set' | 'delete', path, value? }; the host applies it through the MVU rail and one
    // malformed patch refuses the whole action. A thrown Error refuses the action with its message.
    // A verb declared on a list row posts the ROW's observations — `listPath`, `itemKey` — plus
    // whatever `inputs` below asked for; a list cell may add static args of its own.
    actions: {
        // A single member — a checkbox, a value cell. The label stays; the type is the caller's value.
        setValue(args, root) {
            const path = requireString(args, 'path');
            if (!('value' in args)) throw new Error('args.value is required');
            return [setPatch(root, path, args.value)];
        },

        // A portrait member: the URL to keep, or '' when the menu keeps a local upload instead.
        setPortrait(args, root) {
            const path = requireString(args, 'path');
            return [setPatch(root, path, args.url === undefined || args.url === null ? '' : String(args.url))];
        },

        // One record out of a list. Absent is refused by name — a delete that deletes nothing is not a
        // success the menu should read as one.
        deleteListItem(args, root) {
            const listPath = requireString(args, 'listPath');
            const itemKey = requireString(args, 'itemKey');
            requireItem(root, listPath, itemKey, 'list');
            return [{ op: 'delete', path: listPath + '.' + itemKey }];
        },

        // The detail form's strings, typed by THIS game's table, written per CHANGED field only — a
        // field the form did not show is never touched, and a field typed back unchanged writes
        // nothing.
        editListItem(args, root) {
            const listPath = requireString(args, 'listPath');
            const itemKey = requireString(args, 'itemKey');
            if (!isPlainObject(args.fields)) throw new Error('args.fields must be an object of field → string');
            const item = requireItem(root, listPath, itemKey, 'list');
            if (!isPlainObject(item)) throw new Error('"' + itemKey + '" in "' + listPath + '" is not a record');
            const itemPath = listPath + '.' + itemKey;
            const patches = [];
            for (const [field, text] of Object.entries(args.fields)) {
                if (field === '$key' || field === '$meta' || field === 'template') continue;
                const typed = typeField(fieldKind(listPath, field), text, field);
                const current = getV(item, field, undefined);
                if (sameValue(current, typed)) continue;
                patches.push(setPatch(root, itemPath + '.' + field, typed));
            }
            return patches;
        },

        // Carry an inventory item: the row's list is the inventory, `charPath` is who receives it
        // (asked through inputs.equip), and it moves to their Belongings (the layout may name
        // another container in `equipmentPath`), one unit at a time — the inventory Qty decrements
        // and the last unit leaves; a Belongings record carries its own Qty (the schema requires
        // one), so a key already carried stacks. No slots, no limits, no bonuses in School.
        equip(args, root) {
            const itemKey = requireString(args, 'itemKey');
            const inventoryPath = requireString(args, 'listPath');
            const charPath = requireString(args, 'charPath');
            const destPath = typeof args.equipmentPath === 'string' && args.equipmentPath ? args.equipmentPath : charPath + '.' + CARRIED_LEAF;
            const item = requireItem(root, inventoryPath, itemKey, 'inventory');
            if (!isPlainObject(item)) throw new Error('"' + itemKey + '" in "' + inventoryPath + '" is not an item record');
            const dest = requireContainer(root, destPath, 'belongings');

            const patches = [];
            if (Object.prototype.hasOwnProperty.call(dest, itemKey) && isPlainObject(dest[itemKey])) {
                const have = Number(getV(dest[itemKey], 'Qty', 0));
                patches.push(setPatch(root, destPath + '.' + itemKey + '.Qty', (Number.isFinite(have) ? have : 0) + 1));
            } else {
                patches.push({ op: 'set', path: destPath + '.' + itemKey, value: Object.assign({}, item, { Qty: 1 }) });
            }
            const qty = Number(getV(item, 'Qty', 1));
            if (Number.isFinite(qty) && qty > 1) patches.push(setPatch(root, inventoryPath + '.' + itemKey + '.Qty', qty - 1));
            else patches.push({ op: 'delete', path: inventoryPath + '.' + itemKey });
            return patches;
        },

        // The reverse: the row's list is the carrier's Belongings, and the item returns to the
        // inventory (the layout may name it in `inventoryPath`), stacking onto a same-keyed entry's
        // Qty or arriving as one unit.
        unequip(args, root) {
            const equipKey = requireString(args, 'itemKey');
            const equipmentPath = requireString(args, 'listPath');
            const inventoryPath = typeof args.inventoryPath === 'string' && args.inventoryPath ? args.inventoryPath : INVENTORY_PATH;
            const item = requireItem(root, equipmentPath, equipKey, 'belongings');
            if (!isPlainObject(item)) throw new Error('"' + equipKey + '" in "' + equipmentPath + '" is not an item record');
            const inventory = requireContainer(root, inventoryPath, 'inventory');

            const patches = [];
            if (Object.prototype.hasOwnProperty.call(inventory, equipKey) && isPlainObject(inventory[equipKey])) {
                const have = Number(getV(inventory[equipKey], 'Qty', 0));
                patches.push(setPatch(root, inventoryPath + '.' + equipKey + '.Qty', (Number.isFinite(have) ? have : 0) + 1));
            } else {
                patches.push({ op: 'set', path: inventoryPath + '.' + equipKey, value: Object.assign({}, item, { Qty: 1 }) });
            }
            patches.push({ op: 'delete', path: equipmentPath + '.' + equipKey });
            return patches;
        },

        // The game-start screen's confirm: what the player typed and spent, written as Mainchar pairs,
        // and SaveInfo.GameStarted raised so the screen becomes a record. A character is created once —
        // refused while the flag is up — and the stats are held to the budget above whatever the form's
        // own copy said. `args` is { name, age, gender, race, stats: { Str, Sta, Int, Cha } }.
        startGame(args, root) {
            if (isTrueFlag(getRaw(root, 'SaveInfo.GameStarted', false))) throw new Error('the character is already created — values are locked');
            const patches = [];
            for (const [field, key] of START_IDENTITY) {
                const text = typeof args[field] === 'string' ? args[field].trim() : '';
                if (!text) throw new Error('args.' + field + ' must be a non-empty string');
                patches.push(tuplePatch(root, 'Mainchar.' + key, text, key));
            }
            if (!isPlainObject(args.stats)) throw new Error('args.stats must be an object of stat → whole number');
            let spent = 0;
            for (const key of Object.keys(START_STAT_LABEL)) {
                const value = args.stats[key];
                if (!Number.isInteger(value)) throw new Error('stat "' + key + '" must be a whole number, got ' + JSON.stringify(value));
                if (value < START_STAT_MIN[key] || value > START_STAT_MAX) {
                    throw new Error('stat "' + key + '" must be between ' + START_STAT_MIN[key] + ' and ' + START_STAT_MAX + ', got ' + value);
                }
                spent += value;
                patches.push(tuplePatch(root, 'Mainchar.' + key, value, START_STAT_LABEL[key]));
            }
            if (spent !== START_POINTS) throw new Error('the stats spend ' + spent + ' points; the budget is exactly ' + START_POINTS);
            patches.push(setPatch(root, 'SaveInfo.GameStarted', true));
            return patches;
        },
    },

    // What a verb NEEDS from the player, answered at click time from this game's own knowledge (D8).
    // The menu draws whatever comes back — a pick as a select, a number as a number box — and holds
    // no idea of its own who can carry things. A verb absent here needs nothing beyond its row.
    inputs: {
        // Who can receive the item: anyone with a Belongings container — the player, and every
        // classmate who keeps one. ONE candidate and the menu asks nothing; none and the verb is
        // refused by name rather than offered an empty list.
        equip(args, root) {
            const options = [];
            if (isPlainObject(getRaw(root, 'Mainchar.' + CARRIED_LEAF, null))) {
                options.push({ value: 'Mainchar', label: String(getV(root, 'Mainchar.Name', 'Mainchar')) });
            }
            const roster = isPlainObject(root.Classmate) ? root.Classmate : {};
            for (const key of Object.keys(roster)) {
                if (!isPlainObject(getRaw(root, 'Classmate.' + key + '.' + CARRIED_LEAF, null))) continue;
                options.push({ value: 'Classmate.' + key, label: String(getV(root, 'Classmate.' + key + '.Name', key)) });
            }
            if (!options.length) throw new Error('nobody in this state has a ' + CARRIED_LEAF + ' container to receive an item');
            return [{ name: 'charPath', kind: 'pick', label: 'Give to', options }];
        },
    },
};
