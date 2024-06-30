require('dotenv').config()
// get apikey from: https://makersuite.google.com/app/apikey

module.exports = () => ({
    adminGroup: process.env.ADMIN || '',
    apiKey: process.env.GEMINI_KEY || '',
    mods: (process.env.MODS || '923224875937').split(', ').map((jid) => `${jid}@s.whatsapp.net`),
    port: process.env.PORT || 3000,
    prefix: process.env.PREFIX || '/'
})
