'use strict';
/* Interface language (Turkish or English), picked in Settings and kept per device.
   The Turkish text in app.js is the key: T('Oynat') gives "Play" in English. {name} marks a value filled in by the
   caller, and "one|many" picks the English plural from {n}. A key missing here shows the Turkish text.
   Titles, plots and other details from TMDb stay in the language the server fetched them in. */
const LANG = (() => { try { return JSON.parse(localStorage.getItem('lang')) === 'en' ? 'en' : 'tr'; } catch { return 'tr'; } })();
const LOCALE = LANG === 'en' ? 'en-GB' : 'tr-TR';
// The server sends titles, descriptions and genres in the language it finds in this cookie.
try { document.cookie = 'hf_lang=' + LANG + '; path=/; max-age=31536000; samesite=lax'; } catch {}

const EN = {
  // music videos
  'Klipler': 'Music Videos', 'Klip': 'Music', 'Müzik Klipleri': 'Music Videos', '{n} klip': '{n} music video|{n} music videos',
  '{n} sanatçı': '{n} artist|{n} artists', 'Karışık Çal': 'Shuffle Play', 'Sanatçı veya şarkı ara…': 'Search artists or songs…',
  'Son Eklenenler': 'Recently Added', 'Tüm Klipler': 'All Music Videos', 'Sanatçı (A–Z)': 'Artist (A–Z)', 'Şarkı (A–Z)': 'Song (A–Z)',
  'Bilinmeyen sanatçı': 'Unknown artist', 'Henüz klip yok': 'No music videos yet',
  'Ayarlar › Kütüphane bölümünden müzik klibi klasörü ekleyin.': 'Add a music video folder in Settings › Library.',
  'Klip bulunamadı': 'No music videos found', 'Klip listesi alınamadı': 'Could not load the music videos',
  'Müzik klibi klasörleri': 'Music video folders', 'Bu klasörü müzik klibi klasörü olarak ekle': 'Add this folder as a music video folder',
  'Sonraki klip (N)': 'Next music video (N)', 'Sıradaki: {t}': 'Up next: {t}', 'Sanatçılar': 'Artists',
  '{a} klipleri': 'More from {a}', 'Benzer Klipler': 'Similar Music Videos', 'Başka Klipler': 'More Music Videos', 'Albüm': 'Album',
  'Yıl': 'Year', 'Tür': 'Genre',

  // navigation and page titles
  'Lumbuz ana sayfa': 'Lumbuz home', 'Ana Sayfa': 'Home', 'Filmler': 'Movies', 'Diziler': 'Series',
  'Koleksiyonlar': 'Collections', 'Canlı TV': 'Live TV', 'Canlı': 'Live', 'Listem': 'My List', 'Ayarlar': 'Settings',
  'Ara': 'Search', 'Ara ( / )': 'Search ( / )', 'Rastgele film': 'Random movie', 'Kapat': 'Close', 'Geri': 'Back',
  'İleri': 'Forward', 'Tümü': 'All', 'Tümünü gör': 'See all', 'Sırala': 'Sort', 'Online': 'Online',
  'Film, dizi veya tür ara…': 'Search movies, series or genres…',

  // cards, rows and details
  'Film': 'Movie', 'Dizi': 'Series', 'Koleksiyon': 'Collection', 'KÜTÜPHANEDE': 'IN LIBRARY', 'YENİ': 'NEW',
  'SIRADAKİ': 'UP NEXT', 'Listeden kaldır': 'Remove from list', 'Kaldır': 'Remove',
  '{n} film': '{n} movie|{n} movies', '{n} dizi': '{n} series', '{n} seri': '{n} series',
  '{n} sezon': '{n} season|{n} seasons', '{n} bölüm': '{n} episode|{n} episodes', '{n} içerik': '{n} title|{n} titles',
  'serinin {n} filminden': 'of {n} in the series', 'Seride {n} film var': 'The series has {n} movies',
  '{h} sa {m} dk': '{h}h {m}m', '{h} sa': '{h}h', '{m} dk': '{m} min',
  '{h} sa {m} dk kaldı': '{h}h {m}m left', '{m} dk kaldı': '{m} min left',
  'Öne çıkan {n}': 'Featured {n}', 'Oynat': 'Play', 'Devam Et': 'Resume', 'Baştan Başla': 'Start Over',
  'İzlemeye Başla': 'Start Watching', 'Daha Fazla Bilgi': 'More Info', 'Yeni Eklendi': 'Just Added',
  'Öne Çıkan Film': 'Featured Movie', 'İzlemeye Devam Et': 'Continue Watching', 'Yeni Eklenenler': 'Recently Added',
  'En Yüksek Puanlılar': 'Top Rated', 'Bugün Ne İzlesem?': 'What Should I Watch Today?',
  'Yeni eklenen': 'Recently added', 'Puan (yüksek)': 'Rating (high)', 'Puan (düşük)': 'Rating (low)',
  'İsim (A–Z)': 'Name (A–Z)', 'Yıl (yeni)': 'Year (newest)', 'Yıl (eski)': 'Year (oldest)',
  'Bu türde içerik yok': 'Nothing in this genre', 'Başka bir tür seçmeyi deneyin.': 'Try another genre.',
  'Henüz koleksiyon yok': 'No collections yet',
  'Film bilgileri tamamlandıkça devam filmleri burada gruplanacak.': 'Sequels will be grouped here as movie details are filled in.',
  'Listeniz boş': 'Your list is empty',
  'Bir filmin ya da dizinin sayfasındaki + düğmesiyle buraya ekleyin.': 'Add titles here with the + button on a movie or series page.',
  'İndir': 'Download', 'Bu sürümü indir': 'Download this version', 'Bölümü indir': 'Download episode',
  'Listemden çıkar': 'Remove from My List', 'Listeme ekle': 'Add to My List',
  'Orijinal ad': 'Original title', 'Türler': 'Genres', 'Kütüphaneye eklendi': 'Added to library', 'Sürümler': 'Versions',
  'varsayılan': 'default', 'Bu içerik için açıklama bulunamadı.': 'No description available.', 'Bölümler': 'Episodes',
  'Koleksiyonu aç': 'Open collection', 'Benzer İçerikler': 'More Like This', 'Seriye Başla': 'Start the Series',
  'Sıradakini İzle': 'Watch Next', 'Çıkış sırasına göre': 'In release order', 'Bölüm bulunamadı': 'No episodes found',
  'Sezon {n}': 'Season {n}', 'Özel ve Ekstralar': 'Specials and Extras', '{n}. Bölüm': 'Episode {n}', 'İzlendi': 'Watched', 'Yayın': 'Airs',
  '<b>{t}</b> listene eklendi': 'Added <b>{t}</b> to your list', '<b>{t}</b> listenden çıkarıldı': 'Removed <b>{t}</b> from your list',
  'Türlere göz atın': 'Browse genres', 'Kütüphanede {n} sonuç': '{n} result in your library|{n} results in your library',
  'Kütüphanede sonuç yok': 'No results in your library', '{n} sonuç': '{n} result|{n} results',

  // kids zone
  'Çizgi filmler, animasyonlar ve aile filmleri burada! {n} macera seni bekliyor.':
    'Cartoons, animations and family movies are all here! {n} adventures are waiting for you.',
  '🎲 Sürpriz Film!': '🎲 Surprise Movie!', '🌟 En Sevilenler': '🌟 Most Loved', '🎨 Animasyon Filmleri': '🎨 Animated Movies',
  '📺 Çizgi Diziler': '📺 Cartoon Series', '🧸 Film Serileri': '🧸 Movie Series', '✨ Macera ve Fantastik': '✨ Adventure & Fantasy',
  '👨‍👩‍👧 Aile Filmleri': '👨‍👩‍👧 Family Movies', '😂 Komediler': '😂 Comedies', '🆕 Yeni Gelenler': '🆕 New Arrivals',
  'Henüz çocuk filmi yok': 'No kids movies yet',
  'Animasyon ve aile filmleri eklendikçe burada görünecek.': 'Animated and family movies will show up here as they are added.',

  // downloads
  'Sunucuya ulaşılamadı.': 'Could not reach the server.',
  'Bu cihazda zaten bir indirme sürüyor: <b>{name}</b> (%{pct}). O bitince yenisini başlatabilirsiniz.':
    'A download is already running on this device: <b>{name}</b> ({pct}%). You can start another one when it finishes.',
  'İndirme başladı. Ağı yormamak için hız sınırlıdır, bu biraz sürebilir.':
    'Download started. Its speed is limited to keep the network free, so it may take a while.',

  // settings
  'Kütüphane': 'Library', 'Film klasörü': 'Movies folder', 'Dizi klasörü': 'Series folder', 'OMDb API anahtarı': 'OMDb API key',
  'Kaydet ve Tara': 'Save and Scan', 'Yeniden Tara': 'Rescan', 'Eksik Bilgileri Tekrar Ara': 'Look Up Missing Details Again',
  'Diğer cihazlardan bağlan': 'Connect from other devices', 'Kopyala': 'Copy',
  'Telefon, tablet veya TV tarayıcısından bu adrese girin. Aynı Wi-Fi ağında olmanız yeterli.':
    'Open this address in a phone, tablet or TV browser. The device only needs to be on the same Wi-Fi network.',
  'Klavye kısayolları': 'Keyboard shortcuts', 'Boşluk': 'Space', 'Oynat / Duraklat': 'Play / Pause',
  '10 sn geri / ileri': '10 s back / forward', 'Ses': 'Volume', 'Tam ekran': 'Full screen', 'Sessiz': 'Mute',
  'Ses ve altyazı': 'Audio and subtitles', 'Sonraki bölüm': 'Next episode',
  "Lumbuz · Film bilgileri TMDb, Emby ve OMDb'den alınır.": 'Lumbuz · Movie details come from TMDb, Emby and OMDb.',
  'Dil': 'Language',
  'Menüler ve düğmeler bu dilde görünür. Film adları ve özetleri TMDb’den geldiği gibi kalır.':
    'Menus and buttons use this language. Titles and plots stay as they come from TMDb.',
  'İndirme hız sınırı': 'Download speed limit', '{v} Mbit/sn': '{v} Mbit/s',
  'Bütün indirmeler birlikte bu hızı geçmez. Her cihaz aynı anda yalnızca bir dosya indirebilir.':
    'All downloads together stay under this speed. Each device can download one file at a time.',
  'Kaydedilemedi': 'Could not save', 'İndirme sınırı {v} Mbit/sn': 'Download limit {v} Mbit/s',
  // settings page: categories, rows and tiles
  'İndirmeler': 'Downloads', 'Diğer cihazlar': 'Other devices', 'Hakkında': 'About', 'Depo': 'Repository', 'Sürüm': 'Version',
  'Klasörler, tarama ve eksik film bilgileri.': 'Folders, scanning and missing movie details.',
  'Altyazının görünüşü ve kendiliğinden açılması.': 'How subtitles look and when they turn on by themselves.',
  'Rastgele film düğmesinin hangi filmlerden seçeceği.': 'Which movies the random movie button picks from.',
  'Kütüphane dosyaları indirilirken ağın ne kadarının kullanılacağı.': 'How much of the network downloads of library files may use.',
  'Telefon, tablet ve TV’den Lumbuz’a bağlanın.': 'Connect to Lumbuz from a phone, tablet or TV.',
  'Menülerin ve düğmelerin dili.': 'The language of menus and buttons.',
  'Bilgisayarda klavyeyle hızlı kullanım.': 'Quick keyboard use on a computer.',
  'Lumbuz ve bilgilerin geldiği yerler.': 'Lumbuz and where its details come from.',
  'Film klasörleri': 'Movie folders', 'Dizi klasörleri': 'Series folders', 'Klasör ekle': 'Add folder',
  'Henüz klasör eklenmedi.': 'No folders added yet.', 'Bir disk veya klasör seçin': 'Choose a drive or folder',
  'Bu klasörü film klasörü olarak ekle': 'Add this folder as a movie folder',
  'Bu klasörü dizi klasörü olarak ekle': 'Add this folder as a series folder', 'Üst klasör': 'Parent folder',
  'Bu klasörde alt klasör yok.': 'This folder has no subfolders.', 'Vazgeç': 'Cancel',
  'Bu klasör açılamadı': 'This folder could not be opened', 'Klasör eklendi, tarama başladı': 'Folder added, scan started',
  '{d} kütüphaneden çıkarılsın mı? Diskteki dosyalar silinmez.': 'Remove {d} from the library? The files on disk are not deleted.',
  'Klasör çıkarıldı': 'Folder removed', 'Anahtarı kaydeder ve kütüphaneyi baştan tarar.': 'Saves the key and scans the library again.',
  'Klasörler': 'Folders', 'Klasörleri kaydeder ve kütüphaneyi baştan tarar.': 'Saves the folders and scans the library again.',
  'Tarama': 'Scanning', 'Diskteki yeni ve silinen dosyaları bulur.': 'Finds new and deleted files on disk.',
  'Bilgisi veya afişi bulunamayan içerikleri yeniden arar.': 'Looks again for titles that are missing details or posters.',
  'Altyazılar böyle görünecek.': 'Subtitles will look like this.', 'Görünüm': 'Look', 'Seçim': 'Choice',
  'Yazının arkasını koyulaştırır, açık sahnelerde okumayı kolaylaştırır.': 'Darkens the area behind the text, easier to read in bright scenes.',
  'Türkçe altyazıyı kendiliğinden aç': 'Turn on Turkish subtitles automatically',
  'Video Türkçe konuşmuyorsa önce dosyadaki, yoksa internetteki Türkçe altyazı açılır.': 'If the video is not in Turkish, the Turkish subtitle in the file is used, otherwise one from the internet.',
  'Oynatıcıda altyazıyı kapatırsanız bu ayar da kapanır. Altyazı ayarları yalnızca bu cihazda geçerlidir.': 'Turning subtitles off in the player also turns this off. Subtitle settings apply to this device only.',
  'Uyan film': 'Matching movies',
  'Birden fazla tür seçerseniz bunlardan herhangi birine uyan filmler gelir. Bu seçimler yalnızca bu cihazda geçerlidir.': 'With several genres picked, a movie that matches any of them can come up. These choices apply to this device only.',
  'Hız sınırı': 'Speed limit', 'Bütün indirmeler birlikte': 'All downloads together', 'Aynı anda': 'At a time',
  'Cihaz başına 1 dosya': '1 file per device', 'Televizyonlar': 'TVs', 'İndirme düğmesi gizli': 'Download button hidden',
  'Bu adreslerden biri': 'One of these addresses', 'Uygulama': 'App', 'Lisans': 'License', 'Film bilgileri': 'Movie details',
  'Bu sunucu': 'This server',
  'Cihaz başına {n} dosya': '{n} file(s) per device', 'Bir cihazın aynı anda indirebileceği dosya sayısı': 'How many files one device can download at once',
  'Bütün indirmeler birlikte bu hızı geçmez. Bir cihaz aynı anda en fazla bu kadar dosya indirebilir; sayı artınca her indirme hızın daha küçük bir payını alır.':
    'All downloads together stay under this speed. A device can download at most this many files at once; with more downloads, each gets a smaller share of the speed.',
  'Cihaz başına aynı anda {n} indirme': '{n} download(s) at a time per device',
  'Bu cihazda zaten {n} indirme sürüyor. Biri bitince yenisini başlatabilirsiniz.': 'This device already has {n} downloads running. You can start a new one when one finishes.',
  'Bağlı cihazlar': 'Connected devices', 'Bu sunucuyu kullanan cihazlar, adları ve şu an indirdikleri.': 'Devices using this server, their names and what they are downloading now.',
  'Akıllı TV': 'Smart TV', 'Android telefon': 'Android phone', 'Windows bilgisayar': 'Windows computer', 'Linux bilgisayar': 'Linux computer',
  'Bilinmeyen cihaz': 'Unknown device', 'Şu an bağlı': 'Connected now', '{n} dk önce': '{n} min ago', '{n} sa önce': '{n} h ago',
  '{n} gün önce': '{n} days ago', 'Cihaza ad verin': 'Name this device', 'Örn. Kamara 12 laptop': 'e.g. Cabin 12 laptop',
  'Bu cihazı listeden kaldır': 'Remove this device from the list', 'Lumbuz’u tekrar açarsa listeye geri gelir.': 'It comes back to the list if it opens Lumbuz again.',
  'Adı boş bırakırsanız tarayıcısından tahmin edilen ad kullanılır.': 'If you leave the name empty, a name guessed from its browser is used.',
  'İndiren': 'Downloading', 'Şu an indirenler': 'Downloading now', 'Cihazlar': 'Devices', '{n} indirme': '{n} download(s)', 'Ad ver': 'Name',
  'Henüz başka bir cihaz bağlanmadı.': 'No other device has connected yet.',
  'Bir cihaza dokunup ad verebilirsiniz. Adlar yalnızca bu bilgisayarda görünür. Bir cihazın tarayıcı verileri silinirse yeni bir cihaz olarak görünür.':
    'Tap a device to give it a name. Names are shown only on this computer. If a device clears its browser data, it shows up as a new device.',
  'QR kod': 'QR code', 'Telefonun kamerasıyla okutun': 'Scan it with your phone camera',
  'Lumbuz açılır. Sonra tarayıcıda “Ana ekrana ekle” derseniz uygulama gibi kalır.': 'Lumbuz opens. Choose “Add to Home screen” in the browser to keep it like an app.',
  'Telefon, tablet veya TV tarayıcısından bu adrese girin. Aynı Wi-Fi ağında olmanız yeterli. Lumbuz TV uygulaması sunucuyu ağda kendisi bulur.':
    'Open this address in a phone, tablet or TV browser on the same Wi-Fi. The Lumbuz TV app finds the server on the network by itself.',
  'Hepsi': 'Any', 'En düşük puan': 'Minimum rating',
  'Ayarlar kaydedildi, tarama başladı': 'Settings saved, scan started', 'Diskteki dosyalar taranıyor…': 'Scanning files on disk…',
  'Eksik bilgiler yeniden aranıyor': 'Looking up missing details again',
  'Kütüphane taranıyor': 'Scanning library', 'Emby bilgileri okunuyor': 'Reading Emby data',

  // player
  'Video dosyası bulunamadı. Disk bağlı mı?': 'Video file not found. Is the disk connected?',
  'Kaldığın yerden devam ediliyor · {time}': 'Resuming where you left off · {time}',
  'Video oynatılamadı. Dosya bozuk ya da desteklenmiyor olabilir.': 'The video could not be played. The file may be damaged or unsupported.',
  'Şimdi Oynat': 'Play Now', 'Yaratıcı': 'Creator', 'Yönetmen': 'Director', 'Senaryo': 'Writer', 'Ülke': 'Country',
  'İlk yayın': 'First aired', 'Vizyon': 'Released', 'Oyuncular': 'Cast', 'İzliyorsun': 'Now Watching',
  'Benzer Diziler': 'Similar Series', 'Benzer Filmler': 'Similar Movies',
  'Altyazı dosyası okunamadı': 'Could not read the subtitle file', 'Altyazı': 'Subtitles',
  'Gömülü altyazı hazırlanıyor, bu biraz sürebilir…': 'Preparing the built-in subtitles, this may take a moment…',
  'Altyazı yüklenemedi': 'Could not load the subtitles', 'Çevrimiçi altyazı': 'Online subtitles',
  'tam eşleşme': 'exact match', 'Bu video için altyazı bulunamadı.': 'No subtitles found for this video.',
  'Arama başarısız. İnternet bağlantınızı kontrol edin.': 'Search failed. Check your internet connection.',
  'Kapalı': 'Off', 'dosya': 'file', 'otomatik': 'auto', 'gömülü': 'built-in', 'yüklendi': 'loaded', 'indirildi': 'downloaded',
  'Çevrimiçi ara…': 'Search online…', 'Dosyadan yükle…': 'Load from file…', 'Boyut': 'Size', 'Küçük': 'Small',
  'Orta': 'Medium', 'Büyük': 'Large', 'Senkron': 'Sync', '{v} sn': '{v} s', 'Arka plan': 'Background',
  'Altyazı filmin sesine göre hizalanıyor…': 'Lining the subtitles up with the sound…',
  'Altyazı sesle eşleştirilemedi. Senkronu elle ayarlayabilirsiniz.': 'Could not match the subtitles to the sound. You can adjust the sync by hand.',
  'Altyazı zaten filmle uyumlu': 'The subtitles already match the film', 'Altyazı sese göre hizalandı ({v} sn)': 'Subtitles lined up with the sound ({v} s)',
  'Hizalanıyor…': 'Lining up…', 'Sese göre hizalandı': 'Lined up with sound', 'Sese göre hizala': 'Line up with sound',
  'Altyazıyı sese göre hizala': 'Line subtitles up with the sound',
  'İnternetten gelen ya da yüklenen altyazı filmin sesiyle karşılaştırılır ve kayıksa kendiliğinden düzeltilir.': 'Subtitles from the internet or from a file are compared with the film’s sound and fixed automatically if they are off.',
  'Oynatma hızı {v}x': 'Playback speed {v}x', 'İndiriliyor…': 'Downloading…',
  'Altyazı indirilemedi (günlük limit dolmuş olabilir)': 'Could not download the subtitles (the daily limit may be used up)',
  'Ses %{n}': 'Volume {n}%',
  'Türkçe': 'Turkish', 'İngilizce': 'English', 'Almanca': 'German', 'Fransızca': 'French', 'İspanyolca': 'Spanish',
  'İtalyanca': 'Italian', 'Rusça': 'Russian', 'Japonca': 'Japanese', 'Korece': 'Korean', 'Arapça': 'Arabic',
  'Türkçe (internet)': 'Turkish (internet)', 'Varsayılan': 'Default', 'Yerel altyazı': 'Local subtitles',
  // static player controls
  '« 10 sn': '« 10 s', '10 sn »': '10 s »', 'Geri (Esc)': 'Back (Esc)', 'Oynat / Duraklat (Boşluk)': 'Play / Pause (Space)',
  '10 sn geri (←)': '10 s back (←)', '10 saniye geri': '10 seconds back', '10 sn ileri (→)': '10 s forward (→)',
  '10 saniye ileri': '10 seconds forward', 'Sessiz (M)': 'Mute (M)', 'Ses düzeyi': 'Volume', 'Sonraki bölüm (N)': 'Next episode (N)',
  'Ses ve altyazı (C)': 'Audio and subtitles (C)', 'Oynatma hızı': 'Playback speed', 'Hız': 'Speed', 'Tam ekran (F)': 'Full screen (F)',
  'Altyazı dosyasını bırakın': 'Drop a subtitle file here', 'Online oynatıcı': 'Online player', 'Canlı yayın': 'Live stream',
  'Kanallar (OK)': 'Channels (OK)', 'Kanal listesi': 'Channel list',
  '▲▼ kanal · ◀▶ kategori · OK izle · Geri kapat': '▲▼ channel · ◀▶ category · OK watch · Back close',

  // online
  'Kütüphanende olmayan film ve diziler': 'Movies and series that are not in your library',
  'Online katalog yüklenemedi': 'Could not load the online catalog',
  'İnternet bağlantısını ve TMDb anahtarını kontrol edin.': 'Check the internet connection and the TMDb key.',
  'Tekrar Dene': 'Try Again', "Online'da film veya dizi ara…": 'Search movies or series online…',
  'Arama yapılamadı': 'Search failed', 'İnternet bağlantısını kontrol edin.': 'Check the internet connection.',
  '“{q}” için sonuç yok': 'No results for “{q}”',
  'Farklı bir yazım ya da orijinal adıyla aramayı deneyin.': 'Try another spelling or the original title.',
  'Bilgiler alınamadı': 'Could not load the details', 'Kütüphanede Aç': 'Open in Library', 'Kaynak': 'Source',
  'Bölüm bilgisi yok': 'No episode information', 'Bölümler alınamadı': 'Could not load the episodes',
  'İçerik bilgisi alınamadı. İnternet bağlantısını kontrol edin.': 'Could not load the title. Check the internet connection.',
  'Bu dizinin bölüm bilgisi yok.': 'This series has no episode information.',
  'Sonraki bölüm başlıyor · {code}': 'Next episode starting · {code}',
  'Trend Filmler': 'Trending Movies', 'Trend Diziler': 'Trending Series', 'Vizyondakiler': 'In Theaters',
  'Popüler Filmler': 'Popular Movies', 'Popüler Diziler': 'Popular Series', 'Türk Filmleri': 'Turkish Movies',
  'Türk Dizileri': 'Turkish Series', 'En Yüksek Puanlı Filmler': 'Top Rated Movies', 'En Yüksek Puanlı Diziler': 'Top Rated Series',

  // live TV
  'Türkiye': 'Turkey only', 'İZLENİYOR': 'WATCHING', 'CANLI': 'LIVE', 'Kanal listesi alınamadı': 'Could not load the channel list',
  'Lumbuz sunucusuna ulaşılamıyor.': 'Cannot reach the Lumbuz server.', '{n} kanal': '{n} channel|{n} channels',
  'Kanal ara…': 'Search channels…', 'Son İzlediklerin': 'Recently Watched', 'Tüm Kanallar': 'All Channels',
  'Kanal bulunamadı': 'No channels found', 'Başka bir kategori ya da arama deneyin.': 'Try another category or search.',
  'Başka bir arama deneyin.': 'Try another search.', 'Kanal bulunamadı.': 'Channel not found.',
  '{name} şu an açılmıyor': '{name} is not opening right now',
  'Bu kanal yalnızca Türkiye içinden izlenebiliyor. ': 'This channel can only be watched from inside Turkey. ',
  'Başka bir kanal seçin': 'Pick another channel', 'Bu numarada kanal yok.': 'No channel has this number.',
  // live TV: the viewer's own IPTV lists
  'Diğer': 'Other', 'Lumbuz Kanalları': 'Lumbuz Channels', 'IPTV Ekle': 'Add IPTV', 'M3U listesi': 'M3U list',
  'Bitiş: {d}': 'Expires: {d}', '{n} bağlantı': '{n} connection|{n} connections', 'Tüm cihazlarda': 'On all devices',
  'Güncellendi: {d}': 'Updated: {d}', 'Yenile': 'Refresh', 'Düzenle': 'Edit', 'Daha fazla göster ({n})': 'Show more ({n})',
  'Bu sunucuya bağlanan tüm cihazlarda göster': 'Show on every device connected to this server',
  'Kapalıyken liste yalnızca bu cihazda görünür. Açıkken bu Lumbuz’u kullanan herkes aboneliğinizle izleyebilir (TV’de eklemek yerine telefondan eklemek için kullanışlı).':
    'When off, the list only shows on this device. When on, everyone using this Lumbuz can watch with your subscription (handy for adding it from a phone instead of typing on the TV).',
  'IPTV listesini düzenle': 'Edit IPTV list', 'Liste adı': 'List name', 'Kaydet': 'Save', 'Listeyi sil': 'Delete list',
  'IPTV aboneliğiniz varsa kanal listenizi buraya ekleyin. Kanallar bu cihazda, doğrudan sağlayıcınızdan açılır.':
    'If you have an IPTV subscription, add your channel list here. Channels play on this device, straight from your provider.',
  'M3U bağlantısı': 'M3U link', 'Liste adı (isteğe bağlı)': 'List name (optional)', 'Örn. Ev IPTV': 'e.g. Home IPTV',
  'Sunucu adresi': 'Server address', 'Kullanıcı adı': 'Username', 'Şifre': 'Password', 'Listeyi ekle': 'Add list',
  'Lütfen tüm alanları doldurun.': 'Please fill in all fields.', 'Kanal listesi yenileniyor…': 'Refreshing the channel list…',
  'Silmek için tekrar basın': 'Press again to delete', 'Liste okunuyor…': 'Reading the list…',
  '{name}: {n} kanal eklendi': '{name}: {n} channel added|{name}: {n} channels added',
  'Bu IPTV yayını şifresiz (http) olduğu için güvenli (https) adreste açılmıyor; Lumbuz’u ev ağındaki adresinden açın. ':
    'This IPTV stream is unencrypted (http), so it does not open on a secure (https) address; open Lumbuz from its home network address. ',
  'IPTV sağlayıcınız yayını vermedi: abonelik süresi ya da aynı anda bağlantı sınırı dolmuş olabilir. ':
    'Your IPTV provider did not send the stream: the subscription may have expired or its connection limit may be reached. ',
  'BOZUK': 'BROKEN', 'Kontrol ediliyor: {d}/{t} · {n} bozuk': 'Checking: {d}/{t} · {n} broken', 'Durdur': 'Stop',
  '“{g}” kanallarını kontrol et': 'Check “{g}” channels', 'Tüm kanalları kontrol et': 'Check all channels',
  '{n} bozuk kanal gizli': '{n} broken channel hidden|{n} broken channels hidden', 'Bozukları gizle': 'Hide broken',
  'Bozukları göster': 'Show broken', 'Hepsini geri getir': 'Bring all back',
  'Kontrol bitti: {n} bozuk kanal gizlendi': 'Check finished: {n} broken channel hidden|Check finished: {n} broken channels hidden',
  'Gizlenen kanallar geri getirildi': 'Hidden channels are back',
  // messages from the server (iptv.py)
  'Bağlantı http:// ya da https:// ile başlamalı.': 'The link must start with http:// or https://.',
  'Bu adres kullanılamaz.': 'This address cannot be used.', 'Sunucu bulunamadı. Adresi kontrol edin.': 'Server not found. Check the address.',
  'IPTV sunucusuna bağlanılamadı.': 'Could not connect to the IPTV server.',
  'IPTV sunucusu girişi kabul etmedi. Kullanıcı adı ve şifreyi kontrol edin.': 'The IPTV server refused the login. Check the username and password.',
  'Kanal listesi çok büyük.': 'The channel list is too large.', 'Kanal listesi indirilemedi.': 'Could not download the channel list.',
  'Bu bağlantı bir M3U kanal listesi değil.': 'This link is not an M3U channel list.',
  'Listede canlı kanal bulunamadı.': 'No live channels were found in the list.',
  'Bu adres bir Xtream Codes sunucusu değil.': 'This address is not an Xtream Codes server.',
  'Kanal listesi okunamadı.': 'Could not read the channel list.', 'Geçersiz liste türü.': 'Invalid list type.',
  'Ulusal': 'National', 'Haber': 'News', 'Spor': 'Sports', 'Belgesel': 'Documentary', 'Çocuk': 'Kids', 'Müzik': 'Music', 'Dünya': 'World',

  // random movie, misc
  'Rastgele film ayarlarına uyan film yok. Ayarlar’dan seçimleri genişletin.': 'No movie matches the random movie settings. Widen them in Settings.',
  'Kütüphanede film yok.': 'There are no movies in the library.', 'Rastgele seçildi: <b>{t}</b>': 'Random pick: <b>{t}</b>',
  'Adres kopyalandı': 'Address copied', 'Sunucuya ulaşılamıyor': 'Cannot reach the server',
  'Lumbuz sunucusunun çalıştığından emin olun ve sayfayı yenileyin.': 'Make sure the Lumbuz server is running and reload the page.',

  // genres (TMDb's Turkish names, also the library's)
  'Aksiyon': 'Action', 'Macera': 'Adventure', 'Animasyon': 'Animation', 'Komedi': 'Comedy', 'Suç': 'Crime', 'Dram': 'Drama',
  'Aile': 'Family', 'Fantastik': 'Fantasy', 'Tarih': 'History', 'Korku': 'Horror', 'Müzikal': 'Musical', 'Gizem': 'Mystery',
  'Romantik': 'Romance', 'Bilim-Kurgu': 'Science Fiction', 'Bilim Kurgu': 'Science Fiction', 'Gerilim': 'Thriller', 'Savaş': 'War',
  'Vahşi Batı': 'Western', 'Biyografi': 'Biography', 'Kısa': 'Short', 'TV Filmi': 'TV Movie', 'TV film': 'TV Movie',
  'Aksiyon & Macera': 'Action & Adventure', 'Gerçeklik': 'Reality', 'Bilim Kurgu & Fantazi': 'Sci-Fi & Fantasy',
  'Pembe Dizi': 'Soap', 'Talk Show': 'Talk Show', 'Savaş & Politik': 'War & Politics',
};

// The same Turkish word reads differently in some static places of the page.
const EN_PAGE = { 'Koleksiyon': 'Collections', 'Ses': 'Volume' };

function T(s, vars) {
  let out = LANG === 'en' && EN[s] !== undefined ? EN[s] : s;
  if (vars) {
    if (LANG === 'en' && out.includes('|')) { const [one, many] = out.split('|'); out = vars.n === 1 ? one : many; }
    out = out.replace(/\{(\w+)\}/g, (m, k) => (vars[k] !== undefined ? vars[k] : m));
  }
  return out;
}
// Picks between two wordings where one Turkish word has two English meanings ("Ses": volume or audio track).
const T2 = (tr, en) => (LANG === 'en' ? en : tr);
// Episode code: S1:B2 in Turkish ("bölüm"), S1:E2 in English.
const epCode = (s, e) => `S${s}:${LANG === 'en' ? 'E' : 'B'}${e}`;

// Text the server sends (row titles, genres, channel categories, track labels, status lines): known pieces are
// translated, anything else (names, file names) is left as it is.
const TX_PATTERNS = [
  [/^Bilgiler zenginleştiriliyor (.*)$/, 'Fetching details $1'],
  [/^Oyuncu bilgileri indiriliyor (.*)$/, 'Downloading cast details $1'],
  [/^IPTV sunucusu hata verdi \((\d+)\)\.$/, 'The IPTV server returned an error ($1).'],
];
function tx(s) {
  if (LANG !== 'en' || !s) return s;
  if (EN[s] !== undefined) return EN[s];
  for (const [re, to] of TX_PATTERNS) if (re.test(s)) return s.replace(re, to);
  s = s.replace(/\bS(\d+):B(\d+)\b/g, 'S$1:E$2');
  return s.split(' · ').map(p => {
    if (EN[p] !== undefined) return EN[p];
    const m = p.match(/^(.*?)(\s*\(.*\))$/);
    return m && EN[m[1]] !== undefined ? EN[m[1]] + m[2] : p;
  }).join(' · ');
}

// The page's own (static) text: labels, tooltips and placeholders.
function i18nPage(root = document.body) {
  document.documentElement.lang = LANG;
  if (LANG !== 'en') return;
  const tr = s => { const k = s.trim(); return EN_PAGE[k] || EN[k]; };
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  for (let n = walker.nextNode(); n; n = walker.nextNode()) {
    const v = n.nodeValue.trim() && tr(n.nodeValue);
    if (v) n.nodeValue = n.nodeValue.replace(n.nodeValue.trim(), v);
  }
  root.querySelectorAll('[title], [aria-label], [placeholder]').forEach(el => {
    for (const a of ['title', 'aria-label', 'placeholder']) {
      const v = el.hasAttribute(a) && tr(el.getAttribute(a));
      if (v) el.setAttribute(a, v);
    }
  });
}
