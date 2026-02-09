// Tours Data - 找到了旅行社行程資料庫
// Last Updated: 2026-02-09

const toursData = {
    bangkok6day: {
        id: 'bangkok6day',
        name: '曼谷超值無購物6日',
        destination: 'thailand',
        destinationName: '泰國',
        destinationFlag: '🇹🇭',
        days: 6,
        nights: 5,
        airline: '泰越捷航空',
        highlights: [
            { icon: '🐘', title: '東芭樂園', desc: '泰國文化表演＋大象表演一次看' },
            { icon: '🏛️', title: '暹羅76府古城', desc: '一日環遊泰國經典建築' },
            { icon: '🛶', title: '華麗室內水上市場', desc: '泡泡馬特全球限定店必逛' },
            { icon: '💗', title: 'TUTU Beach', desc: '粉紅系海景咖啡廳，拍照超夢幻' }
        ],
        features: ['免領隊小費', '免司機小費', '免導遊小費', '全程無購物'],
        itinerary: [
            { day: 1, title: '台北 → 曼谷', desc: '搭乘泰越捷航空前往曼谷，抵達後專車接機，入住飯店休息。' },
            { day: 2, title: '東芭樂園 → 七珍佛山 → 九世皇廟', desc: '上午前往東芭樂園觀賞泰國傳統文化表演及大象表演，下午參觀七珍佛山、九世皇廟。' },
            { day: 3, title: '暹羅76府古城 → 華麗室內水上市場', desc: '全日暢遊暹羅古城，一次看遍泰國76府經典建築，下午前往華麗室內水上市場及泡泡馬特全球限定店。' },
            { day: 4, title: 'TUTU Beach → ICONSIAM暹邏天地', desc: '上午前往網美必拍TUTU Beach粉紅海景咖啡廳，下午至ICONSIAM暹邏天地自由購物。' },
            { day: 5, title: '美軍不夜城 → Terminal 21 → 河濱夜市', desc: '上午自由活動，下午前往Terminal 21購物中心，晚上逛河濱夜市品嚐泰式美食。' },
            { day: 6, title: '曼谷 → 台北', desc: '享用飯店早餐後，專車送機，搭機返回溫暖的家。' }
        ],
        priceTiers: [
            {
                price: 15900,
                badge: '🔥 超值首選',
                dates: ['04/08', '04/15', '04/22', '04/24'],
                note: '4月出發限定價'
            },
            {
                price: 17900,
                badge: '熱銷中',
                dates: ['04/10', '05/06', '05/08', '05/13', '05/15', '05/20', '05/22', '05/27', '05/29', '06/03', '06/05', '06/10', '06/12', '08/26', '08/28', '09/02', '09/04', '09/09', '09/11', '09/16', '09/18'],
                note: '5-6月、8-9月出發'
            },
            {
                price: 19900,
                badge: '🌴 暑假出發',
                dates: ['06/24', '06/26', '07/01', '07/03', '07/08', '07/10', '07/15', '07/17', '07/22', '07/24', '07/29', '07/31', '08/05', '08/07', '08/12', '08/14', '08/19', '08/21'],
                note: '暑假檔期'
            },
            {
                price: 18900,
                badge: '🍂 秋季優惠',
                dates: ['09/30', '10/02', '10/14', '10/16', '10/21'],
                note: '秋季出發'
            }
        ],
        included: [
            '來回機票（含稅金、燃油附加費）',
            '全程飯店住宿5晚',
            '行程所列餐食',
            '行程所列景點門票',
            '全程專車接送',
            '200萬旅遊責任險+20萬醫療險'
        ],
        notIncluded: [
            '護照申辦費用',
            '個人消費（電話、洗衣、飲料等）',
            '行程外自費項目',
            '單人房差價'
        ],
        image: 'linear-gradient(135deg, #ff6b6b 0%, #feca57 100%)'
    }
};

// Plug/Socket Information by Country
const plugData = {
    'taiwan': { name: '台灣', voltage: '110V', frequency: '60Hz', plugTypes: ['A', 'B'], notes: '與美國相同規格' },
    'japan': { name: '日本', voltage: '100V', frequency: '50/60Hz', plugTypes: ['A', 'B'], notes: '東日本50Hz，西日本60Hz' },
    'thailand': { name: '泰國', voltage: '220V', frequency: '50Hz', plugTypes: ['A', 'B', 'C', 'O'], notes: '部分飯店有萬用插座' },
    'korea': { name: '韓國', voltage: '220V', frequency: '60Hz', plugTypes: ['C', 'F'], notes: '需要轉接頭' },
    'vietnam': { name: '越南', voltage: '220V', frequency: '50Hz', plugTypes: ['A', 'C', 'G'], notes: '多種插座並存' },
    'singapore': { name: '新加坡', voltage: '230V', frequency: '50Hz', plugTypes: ['G'], notes: '英式三腳插頭' },
    'malaysia': { name: '馬來西亞', voltage: '240V', frequency: '50Hz', plugTypes: ['G'], notes: '英式三腳插頭' },
    'china': { name: '中國', voltage: '220V', frequency: '50Hz', plugTypes: ['A', 'C', 'I'], notes: '多種插座並存' },
    'hongkong': { name: '香港', voltage: '220V', frequency: '50Hz', plugTypes: ['G'], notes: '英式三腳插頭' },
    'usa': { name: '美國', voltage: '120V', frequency: '60Hz', plugTypes: ['A', 'B'], notes: '與台灣相同' },
    'uk': { name: '英國', voltage: '230V', frequency: '50Hz', plugTypes: ['G'], notes: '英式三腳插頭' },
    'france': { name: '法國', voltage: '230V', frequency: '50Hz', plugTypes: ['C', 'E'], notes: '歐規雙圓孔' },
    'germany': { name: '德國', voltage: '230V', frequency: '50Hz', plugTypes: ['C', 'F'], notes: '歐規雙圓孔' },
    'italy': { name: '義大利', voltage: '230V', frequency: '50Hz', plugTypes: ['C', 'F', 'L'], notes: '有專用L型插頭' },
    'spain': { name: '西班牙', voltage: '230V', frequency: '50Hz', plugTypes: ['C', 'F'], notes: '歐規雙圓孔' },
    'switzerland': { name: '瑞士', voltage: '230V', frequency: '50Hz', plugTypes: ['C', 'J'], notes: '有專用J型插頭' },
    'australia': { name: '澳洲', voltage: '230V', frequency: '50Hz', plugTypes: ['I'], notes: '斜角三孔插頭' },
    'newzealand': { name: '紐西蘭', voltage: '230V', frequency: '50Hz', plugTypes: ['I'], notes: '斜角三孔插頭' },
    'indonesia': { name: '印尼', voltage: '230V', frequency: '50Hz', plugTypes: ['C', 'F'], notes: '歐規雙圓孔' },
    'philippines': { name: '菲律賓', voltage: '220V', frequency: '60Hz', plugTypes: ['A', 'B', 'C'], notes: '多種插座並存' }
};

// Plug Type Descriptions
const plugTypes = {
    'A': { name: 'Type A', desc: '雙扁腳（美規）', countries: '美國、台灣、日本' },
    'B': { name: 'Type B', desc: '雙扁腳+接地', countries: '美國、台灣、日本' },
    'C': { name: 'Type C', desc: '雙圓孔（歐規）', countries: '歐洲大部分國家' },
    'E': { name: 'Type E', desc: '雙圓孔+接地孔', countries: '法國、比利時' },
    'F': { name: 'Type F', desc: '雙圓孔+側接地', countries: '德國、荷蘭' },
    'G': { name: 'Type G', desc: '三方腳（英規）', countries: '英國、香港、新加坡' },
    'I': { name: 'Type I', desc: '斜角三孔', countries: '澳洲、紐西蘭、中國' },
    'J': { name: 'Type J', desc: '三圓孔', countries: '瑞士' },
    'L': { name: 'Type L', desc: '三圓孔一列', countries: '義大利' },
    'O': { name: 'Type O', desc: '三圓孔', countries: '泰國' }
};

// Destination Information
const destinationsData = {
    thailand: {
        id: 'thailand',
        name: '泰國',
        flag: '🇹🇭',
        capital: '曼谷',
        currency: 'THB (泰銖)',
        language: '泰語',
        bestSeason: '11月-2月（涼季）',
        avgTemp: '25-35°C',
        flightTime: '約3.5小時',
        visa: '落地簽30天免費',
        highlights: [
            { name: '大皇宮', desc: '曼谷最著名地標，金碧輝煌的皇室建築群' },
            { name: '臥佛寺', desc: '擁有46公尺長臥佛的古老寺廟' },
            { name: '水上市場', desc: '體驗傳統泰式水上購物文化' },
            { name: '芭達雅', desc: '陽光沙灘、夜生活豐富的海濱度假勝地' },
            { name: '清邁', desc: '泰北玫瑰，古城寺廟與大象保育區' },
            { name: '普吉島', desc: '世界級海島度假天堂' }
        ],
        foods: ['泰式酸辣湯', '綠咖哩', '打拋豬肉', '芒果糯米', '泰式奶茶'],
        tips: ['寺廟需穿著過膝服裝', '不可觸摸他人頭部', '給小費用紙幣', '計程車建議先議價']
    },
    japan: {
        id: 'japan',
        name: '日本',
        flag: '🇯🇵',
        capital: '東京',
        currency: 'JPY (日圓)',
        language: '日語',
        bestSeason: '3-5月（櫻花）/ 10-11月（楓葉）',
        avgTemp: '5-30°C（依季節）',
        flightTime: '約3小時',
        visa: '免簽90天',
        highlights: [
            { name: '東京', desc: '現代與傳統交融的超級都市' },
            { name: '京都', desc: '千年古都，神社寺廟林立' },
            { name: '大阪', desc: '美食天堂，大阪城、環球影城' },
            { name: '北海道', desc: '四季分明，薰衣草與粉雪' },
            { name: '富士山', desc: '日本精神象徵，世界遺產' },
            { name: '沖繩', desc: '亞熱帶海島風情' }
        ],
        foods: ['壽司', '拉麵', '和牛', '天婦羅', '抹茶甜點'],
        tips: ['電車禮儀很重要', '餐廳多禁菸', '泡湯需全裸', '不收小費']
    },
    korea: {
        id: 'korea',
        name: '韓國',
        flag: '🇰🇷',
        capital: '首爾',
        currency: 'KRW (韓元)',
        language: '韓語',
        bestSeason: '3-5月（春）/ 9-11月（秋）',
        avgTemp: '-5-30°C（依季節）',
        flightTime: '約2.5小時',
        visa: 'K-ETA電子簽',
        highlights: [
            { name: '首爾', desc: '韓流文化中心，明洞、弘大、江南' },
            { name: '釜山', desc: '海港城市，海雲台、甘川洞' },
            { name: '濟州島', desc: '韓國夏威夷，火山地形奇景' },
            { name: '南怡島', desc: '冬季戀歌拍攝地' },
            { name: '樂天世界', desc: '世界最大室內遊樂園' },
            { name: 'DMZ', desc: '南北韓非軍事區體驗' }
        ],
        foods: ['韓式烤肉', '炸雞啤酒', '部隊鍋', '石鍋拌飯', '辣炒年糕'],
        tips: ['地鐵很方便', '美妝店很多', '店員會講中文', '酒局文化盛行']
    },
    vietnam: {
        id: 'vietnam',
        name: '越南',
        flag: '🇻🇳',
        capital: '河內',
        currency: 'VND (越南盾)',
        language: '越南語',
        bestSeason: '11月-4月（乾季）',
        avgTemp: '20-35°C',
        flightTime: '約3小時',
        visa: '電子簽證',
        highlights: [
            { name: '河內', desc: '千年古都，三十六古街' },
            { name: '下龍灣', desc: '世界遺產，海上桂林' },
            { name: '胡志明市', desc: '越南經濟中心，法式風情' },
            { name: '峴港', desc: '中越海濱城市，巴拿山' },
            { name: '會安', desc: '古鎮燈籠，世界遺產' },
            { name: '芽莊', desc: '海濱度假，泥漿浴' }
        ],
        foods: ['河粉', '法國麵包', '越式春捲', '滴漏咖啡', '甘蔗蝦'],
        tips: ['過馬路要勇敢', '摩托車很多', '議價是常態', '法語有時通用']
    },
    singapore: {
        id: 'singapore',
        name: '新加坡',
        flag: '🇸🇬',
        capital: '新加坡',
        currency: 'SGD (新加坡幣)',
        language: '英語、華語、馬來語、泰米爾語',
        bestSeason: '全年皆宜',
        avgTemp: '25-32°C',
        flightTime: '約4.5小時',
        visa: '免簽30天',
        highlights: [
            { name: '濱海灣', desc: '金沙酒店、濱海灣花園' },
            { name: '聖淘沙', desc: '環球影城、S.E.A.海洋館' },
            { name: '烏節路', desc: '購物天堂' },
            { name: '牛車水', desc: '新加坡唐人街' },
            { name: '小印度', desc: '印度文化區' },
            { name: '夜間動物園', desc: '全球首座夜間動物園' }
        ],
        foods: ['海南雞飯', '辣椒螃蟹', '肉骨茶', '叻沙', '咖椰吐司'],
        tips: ['禁止口香糖', '罰款很重', '非常乾淨', '英語通用']
    },
    europe: {
        id: 'europe',
        name: '歐洲',
        flag: '🇪🇺',
        capital: '多國首都',
        currency: 'EUR (歐元) / 各國貨幣',
        language: '各國語言',
        bestSeason: '5-9月（夏季）',
        avgTemp: '10-25°C',
        flightTime: '約12-14小時',
        visa: '申根簽證',
        highlights: [
            { name: '巴黎', desc: '浪漫之都，艾菲爾鐵塔、羅浮宮' },
            { name: '羅馬', desc: '永恆之城，鬥獸場、梵蒂岡' },
            { name: '瑞士', desc: '阿爾卑斯山脈、少女峰' },
            { name: '倫敦', desc: '大笨鐘、白金漢宮' },
            { name: '巴塞隆納', desc: '高第建築、地中海風情' },
            { name: '荷蘭', desc: '風車、鬱金香、阿姆斯特丹' }
        ],
        foods: ['法式料理', '義大利麵', '德國豬腳', '西班牙海鮮飯', '瑞士起司鍋'],
        tips: ['注意扒手', '餐廳多收服務費', '禮儀注重', '物價較高']
    }
};

// Export for use in other files (if using modules)
if (typeof module !== 'undefined' && module.exports) {
    module.exports = { toursData, plugData, plugTypes, destinationsData };
}
