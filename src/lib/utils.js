const axios = require('axios').default
const { load } = require('cheerio')
const translate = require('translate-google')
const { readFileSync } = require('fs-extra')
const prompt = readFileSync('./src/prompts/messages.txt', 'utf8')

// translator default: Hebrew
const transcribe = (text) => translate(text, { to: 'iw' }).catch((err) => err.message)

// scraping telegram public channel latest post
const fetch = async (username) => {
    try {
        const { data } = await axios.get(`https://t.me/s/${username}`)
        const $ = load(data)
        // prettier-ignore
        return $('.tgme_widget_message_wrap').map((_, element) => {
            const video = $(element).find('video').attr('src')
            const image = $(element).find('.tgme_widget_message_photo_wrap').attr('style')?.match(/url\('([^']+)'\)/)?.[1]
            const text = $(element).find('.tgme_widget_message_text').text().trim()
            const type = image ? 'image' : video ? 'video' : 'text'
            const caption = text || $(element).next('.tgme_widget_message_text').html()?.trim()?.replace(/<br>/g, '\n')?.replace(/<(?:.|\n)*?>/gm, '')
            const time = $(element).parent().find('.tgme_widget_message_date time').attr('datetime')
            const views = $(element).parent().find('.tgme_widget_message_views').first().text().trim()
            const url = $(element).find('.tgme_widget_message_date').attr('href')
            const id = parseInt(url.split('/').pop() || 0)
            const mediaUrl = video || image
            return { id, type, caption, views, time, url, mediaUrl }
        }).get()
    } catch (error) {
        console.log(error.message)
        return []
    }
}

// convert ms to seconds and minutes
const convertMs = (ms) => {
    const time = ms < 60000 ? ms / 1000 : ms / 60000
    return `${Math.floor(time)} ${ms < 60000 ? 'seconds' : 'minutes'}`
}

// format seconds to mm:ss
const formatSeconds = (ms) => new Date(ms).toISOString().substr(14, 5)

// formatting text for wa markdown
const clean = (text) => text.replace(/\*{2,3}(.*?)\*{2,3}/g, '*$1*')

// chatgpt summarizer
const chatgptSummarize = async (openai, posts, customPrompt) => {
    const messages = [
        { role: 'system', content: customPrompt || prompt }
    ]
    try {
        const time = new Date(new Date().getTime()).toLocaleTimeString()
        const content = JSON.stringify({
            current_time: time,
            posts
        })
        messages.push({ role: 'user', content })
        const chat = await openai.chat.completions.create({
            model: 'gpt-3.5-turbo-16k',
            messages,
            max_tokens: 4096
        })
        const response = chat.choices[0]?.message
        return clean(response.content)
    } catch (error) {
        console.log(error.message)
        return 'chatgpt failed: ' + error.message
    }
}

module.exports = { convertMs, fetch, transcribe, formatSeconds, chatgptSummarize }
