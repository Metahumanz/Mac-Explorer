const { globalShortcut } = require('electron');
const register = globalShortcut.register.bind(globalShortcut);
globalShortcut.register = (key, callback) => key !== process.env.EXPLORER_SHORTCUT_TEST_CONFLICT && register(key, callback);
