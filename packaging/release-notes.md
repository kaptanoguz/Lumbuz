**Lumbuz** (eski adıyla Homeflix), kişisel film ve dizi platformunuz: bilgisayarınızdaki filmleri ve dizileri ev ağındaki telefon, TV ve tarayıcılardan Netflix tarzı bir arayüzle izleyin.

![Lumbuz ana sayfa](https://raw.githubusercontent.com/kaptanoguz/Lumbuz/__VERSION__/docs/screenshots/home.jpg)

## __VERSION__'da yeni

- 📡 **Kendi IPTV listeniz:** Canlı TV sekmesine M3U linki ya da Xtream Codes bilgileriyle kendi IPTV listenizi ekleyin. Liste sunucuda tutulur, gruplara ayrılır ve aranabilir; binlerce kanal olsa da TV yavaşlamaz. Bir listeyi "tüm cihazlarda göster" ile telefondan ekleyip TV'de izleyebilirsiniz.
- 🧹 **Bozuk kanalları bulma:** "Tüm kanalları kontrol et" düğmesi kanalları arka planda tek tek dener (ağı yormadan) ve artık yayın yapmayanları gizler. Gizlenen kanallar 7 gün sonra yeniden denenir; "Bozukları göster" ile hepsini görüp geri getirebilirsiniz.
- 📱 **Telefonda Lumbuz simgesi:** Tarayıcıdan "Ana ekrana ekle" dediğinizde artık Lumbuz adı ve simgesi görünür.
- 🗑️ Eski v2.0 Windows derleme dosyaları kaldırıldı.

<details>
<summary>🇬🇧 What's new in __VERSION__</summary>

- 📡 **Your own IPTV list:** add an M3U link or Xtream Codes login in the Live TV tab. The server keeps the list, splits it into groups and makes it searchable, so even thousands of channels don't slow the TV down. Share a list with "show on all devices" to add it from your phone and watch it on the TV.
- 🧹 **Find broken channels:** "Check all channels" tries each channel quietly in the background and hides the ones that are gone. Hidden channels get another try after 7 days, and "Show broken" lets you see and bring them back.
- 📱 **Lumbuz icon on phones:** "Add to Home screen" now shows the Lumbuz name and icon.
- 🗑️ Old v2.0 Windows build files removed.

</details>

## İndir

| Sistem | Dosya | Not |
|---|---|---|
| 🪟 **Windows** 10/11 (64-bit) | [`Lumbuz-__VERSION__-windows-x64.exe`](https://github.com/kaptanoguz/Lumbuz/releases/download/__VERSION__/Lumbuz-__VERSION__-windows-x64.exe) | Kurulum gerekmez, çift tıklayıp açın |
| 🍎 **macOS** Apple Silicon (M1–M4) | [`Lumbuz-__VERSION__-macos-arm64.dmg`](https://github.com/kaptanoguz/Lumbuz/releases/download/__VERSION__/Lumbuz-__VERSION__-macos-arm64.dmg) | macOS 12 ve üzeri |
| 🍎 **macOS** Intel | [`Lumbuz-__VERSION__-macos-x64.dmg`](https://github.com/kaptanoguz/Lumbuz/releases/download/__VERSION__/Lumbuz-__VERSION__-macos-x64.dmg) | macOS 12 ve üzeri |
| 🐧 **Linux** (64-bit) | [`Lumbuz-__VERSION__-linux-x64.tar.gz`](https://github.com/kaptanoguz/Lumbuz/releases/download/__VERSION__/Lumbuz-__VERSION__-linux-x64.tar.gz) | Ubuntu 22.04+, Debian 12+, Fedora 38+ |
| 📺 **Android TV / telefon** | [Lumbuz TV](https://github.com/kaptanoguz/Lumbuz/releases/tag/android-tv-v1.3) | Sunucuya bağlanan uygulama |

Python ya da başka bir şey kurmanız gerekmez.

## Kurulum

**Windows:** `.exe` dosyasını indirip açın. SmartScreen uyarısı çıkarsa *Ek bilgi → Yine de çalıştır*'a tıklayın.

**macOS:** `.dmg` dosyasını açın ve **Lumbuz**'u *Uygulamalar* klasörüne sürükleyin. Uygulama imzasız olduğu için ilk açılışta macOS engeller: *Sistem Ayarları → Gizlilik ve Güvenlik → Yine de Aç*'a tıklayın (ya da Terminal'de `xattr -dr com.apple.quarantine /Applications/Lumbuz.app`).

**Linux:**
```bash
tar xzf Lumbuz-__VERSION__-linux-x64.tar.gz
cd Lumbuz-__VERSION__-linux-x64
./install.sh            # uygulama menüsüne ekler (isteğe bağlı)
./Lumbuz/Lumbuz     # ya da doğrudan çalıştırın
```
Linux'ta arayüz varsayılan tarayıcıda açılır. Sadece sunucu olarak çalıştırmak için: `./Lumbuz/Lumbuz --headless`

## İlk açılış

1. Lumbuz açılınca **Ayarlar**'dan film ve dizi klasörlerinizi seçin.
2. Diğer cihazlardan `http://<bilgisayarın-ip-adresi>:5000` adresine girin (adres Ayarlar ekranında yazar).
3. MKV/AVI gibi dosyaları canlı dönüştürmek ve gömülü altyazılar için **ffmpeg** gerekir:
   - macOS: `brew install ffmpeg`
   - Linux: `sudo apt install ffmpeg` (Fedora: `sudo dnf install ffmpeg`)
   - Windows: `winget install ffmpeg`

Kütüphane verisi (veritabanı, posterler, `secrets.json`) şurada tutulur. Uygulamanın eski adı Homeflix'ti; daha önce kurduysanız kütüphaneniz eski `Homeflix` klasöründe kalır ve olduğu gibi kullanılır:
- Windows: `%APPDATA%\Lumbuz`
- macOS: `~/Library/Application Support/Lumbuz`
- Linux: `~/.local/share/lumbuz`

TMDb anahtarınızı `secrets.json` dosyasına bu klasörde ekleyebilirsiniz (örnek: [`secrets.example.json`](https://github.com/kaptanoguz/Lumbuz/blob/main/secrets.example.json)).

## Özellikler

- 🏠 Netflix tarzı ana sayfa: öne çıkanlar, İzlemeye Devam Et, Listem, Son Eklenenler, türlere göre satırlar
- 🎞️ TMDb'den poster, açıklama ve puanlar; seri filmler otomatik **Koleksiyon** olur
- 📺 Diziler: bölüm adları, görselleri, izlendi işareti, sonraki bölüme otomatik geçiş
- ▶️ Tarayıcının açamadığı dosyalar (mkv, avi, ts) canlı dönüştürülür; ses dili seçimi
- 💬 Altyazı: yerel dosyalar, mkv içindeki altyazılar ve otomatik Türkçe altyazı
- 🌐 **Online** sekmesi: kütüphanenizde olmayan filmleri ve dizileri izleyin
- 📡 **Canlı TV**: yayıncıların kendi sitelerinden 60'tan fazla ücretsiz kanal, ayrıca kendi IPTV listeniz (M3U ya da Xtream Codes)
- 🎵 **Klipler**: müzik klibi klasörünüzden sanatçı sayfaları ve arka arkaya oynatma
- 🧸 **Kids Zone**: sadece çizgi filmler, animasyonlar ve aile filmleri
- 📱 Kaldığınız yer sunucuda saklanır, telefonda durdurduğunuz filme bilgisayarda devam edersiniz
