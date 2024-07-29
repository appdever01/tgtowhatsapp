const axios = require('axios').default
const { load } = require('cheerio')
const { GoogleGenerativeAI, HarmBlockThreshold, HarmCategory } = require('@google/generative-ai')
const { readFileSync } = require('fs-extra')
const { gemini } = require('../getConfig')()
const translate = require('translate-google')

const prompt = readFileSync('./src/prompts/messages.txt', 'utf8')


const displayIsraelTime = () => {
    const israelTime = new Date().toLocaleTimeString('en-US', {
        timeZone: 'Asia/Jerusalem',
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit',
        hour12: true
    })

    let [time, period] = israelTime.split(' ')
    let [hour, minutes, seconds] = time.split(':')
    hour = (hour === '12' ? 11 : hour - 1) || 12
    period = hour === 12 ? (period === 'AM' ? 'PM' : 'AM') : period
    return `${hour}:${minutes}:${seconds} ${period} - ${time} ${period}`
}
console.log(displayIsraelTime())

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

const safetySettings = [
    {
        category: HarmCategory.HARM_CATEGORY_HATE_SPEECH,
        threshold: HarmBlockThreshold.BLOCK_NONE
    },
    {
        category: HarmCategory.HARM_CATEGORY_SEXUALLY_EXPLICIT,
        threshold: HarmBlockThreshold.BLOCK_NONE
    },
    {
        category: HarmCategory.HARM_CATEGORY_DANGEROUS_CONTENT,
        threshold: HarmBlockThreshold.BLOCK_NONE
    },
    {
        category: HarmCategory.HARM_CATEGORY_HARASSMENT,
        threshold: HarmBlockThreshold.BLOCK_NONE
    }
]

// gemini summarizer
const geminiSummarize = async (posts, customPrompt) => {
    const apiKey = gemini[Math.floor(Math.random() * gemini.length)]
    const model = new GoogleGenerativeAI(apiKey).getGenerativeModel({ model: 'gemini-1.5-flash', safetySettings })
    const messages = [
        { role: 'user', parts: [{ text: customPrompt || prompt }] },
        { role: 'model', parts: [{ text: 'Understood' }] }
    ]
    try {
         const content = JSON.stringify(posts)
        const truncatedContent = content.length > 3000 ? content.substring(0, 3000) : content // Truncate content if it exceeds 3000 characters
        const chat = model.startChat({
            history: messages,
            generationConfig: {
                maxOutputTokens: 4096
            }
        })
        const { response } = await chat.sendMessage(content)
        return clean(response.text())
    } catch (error) {
        console.log(error.response)
         if (error.message.includes('500 Internal Server Error')) {
            console.log('500 Internal server error ')
             try {
                    const content = JSON.stringify(posts)
                    const truncatedContent = content.length > 3000 ? content.substring(0, 3000) : content // Truncate content if it exceeds 3000 characters
                    const chat = model.startChat({
                        history: messages,
                        generationConfig: {
                            maxOutputTokens: 4096
                        }
                    })
                    const { response } = await chat.sendMessage(content)
                    return clean(response.text())
                } catch {
                    console.log(error.message)

                }
         }
        return 'Gemini failed : Can\'t summarize this!!'
    }
}

module.exports = { convertMs, fetch, transcribe, formatSeconds, geminiSummarize, displayIsraelTime }
