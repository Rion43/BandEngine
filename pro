BLE komut kuyruğu sorunu — Mi Band 9 bağlantısı auth sonrası kopuyor

Sorun: Auth başarılı oluyor (AUTH SUCCESS logu görünüyor) ama hemen ardından gattserverdisconnected event’i geliyor. Sebep: onAuthSuccess içinde 27 komut arka arkaya, ACK beklemeden gönderiliyor. Band’in txWin: 3 limiti var — 3’ten fazla unacked paket gelince bağlantıyı kesiyor.

Yapılacak değişiklik:

	1.	Tüm writeValueWithoutResponse çağrılarını bir CommandQueue sınıfından geçir. Bu sınıf her paketi gönderir, notification karakteristiğinden a5 a5 01 ... formatında ACK paketi gelene kadar bekler, sonra sıradakini gönderir.
	2.	Notification handler’da gelen paketi parse ederken: eğer data[2] === 0x01 ise bu bir ACK paketidir, pendingAck promise’ini resolve et.
	3.	onAuthSuccess içindeki tüm komut gönderimlerini (Clock, UserInfo, HealthService vb.) await queue.enqueue(packet) şeklinde sırayla çağır — hepsi aynı anda değil, birer birer.
	4.	ACK timeout’u 3000ms olsun. Timeout olursa Error('ACK timeout — seq: X') fırlat ve bağlantıyı temiz kapat.
	5.	Mevcut TransactionBuilder benzeri bir yapı varsa onu genişlet, yoksa yeni CommandQueue sınıfı ekle.

Kodun ilgili dosyalarını oku, onAuthSuccess fonksiyonunu ve notification handler’ı bul, yukarıdaki mantığa göre düzelt.