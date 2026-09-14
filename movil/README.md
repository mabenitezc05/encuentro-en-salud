# App móvil (Capacitor) — sin tiendas

Contenedor nativo (iOS + Android) que carga la aplicación web publicada en
Render (`https://encuentro-en-salud.onrender.com`). No hay código duplicado:
cada deploy en Render actualiza lo que muestran las apps instaladas.

## Android — APK de instalación directa

Compilar (requiere el JDK y SDK ya instalados en `~/Library/Java` y
`~/Library/Android/sdk`):

```bash
cd movil/android && JAVA_HOME=~/Library/Java/jdk-21.0.12.1+1/Contents/Home ANDROID_HOME=~/Library/Android/sdk ./gradlew assembleRelease
```

El APK firmado queda en
`movil/android/app/build/outputs/apk/release/app-release.apk`.

**Distribución:** compartir el archivo por el medio que prefieras (Drive,
WhatsApp, correo, un QR a un enlace de descarga). En el teléfono: abrir el
APK → Android pedirá permitir "instalar apps desconocidas" de esa fuente →
instalar. Las actualizaciones se instalan encima **solo si están firmadas con
el mismo keystore** — por eso `encuentro-release.keystore` y
`keystore.properties` (fuera del repo, en `movil/android/`) deben respaldarse:
si se pierden, los usuarios tendrían que desinstalar y reinstalar.

## iOS — instalación por Xcode (sideload)

Requiere **Xcode** (App Store) y un iPhone conectado por cable:

1. `npx cap open ios` (o abrir `movil/ios/App` en Xcode).
2. En *Signing & Capabilities*: marcar "Automatically manage signing" y elegir
   tu Apple ID como *Team* (Xcode → Settings → Accounts para agregarlo).
3. Seleccionar el iPhone como destino y pulsar ▶ (Run).
4. En el iPhone: Ajustes → General → VPN y gestión de dispositivos → confiar
   en el desarrollador.

Con Apple ID gratuito la app expira a los **7 días** (se reinstala con ▶) y
admite hasta 3 dispositivos. Con cuenta Apple Developer (US$99/año) la firma
dura 1 año y permite distribución *ad hoc* (hasta 100 dispositivos por UDID).

## Notas

- Los permisos de ubicación están declarados en ambos proyectos
  (`AndroidManifest.xml` y `Info.plist`); el sistema muestra el diálogo nativo
  la primera vez que la app pide GPS.
- Íconos y splash se generan desde `assets/logo.png` (mariposa 1024px):
  `npx @capacitor/assets generate --iconBackgroundColor '#FFFFFF' ...`
- Tras cambiar `capacitor.config.json`: `npx cap sync`.
