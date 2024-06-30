const { join } = require('path')
const fs = require('fs-extra')
const database = join(__dirname, '..', '..', 'database')
fs.ensureDirSync(database)

const readFile = (path, value = {}) => {
    const file = join(database, path)
    return fs.existsSync(file) ? fs.readJSONSync(file) : (fs.outputJSONSync(file, value), value)
}

const writeFile = (path, json) => {
    const file = join(database, path)
    fs.writeJSONSync(file, json, { spaces: 2 })
}

module.exports = { readFile, writeFile }
