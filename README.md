# Oferta de Análisis · Laboratorio Clínico HSJD (PWA)

Aplicación Web Progresiva (PWA) de alta fidelidad para la consulta ágil y 100% fuera de línea de la oferta de análisis preanalíticos del Laboratorio Clínico del Hospital San Juan de Dios (CCSS).

## Características Principales

- **Diseño Adaptativo (Ultra-Responsive)**: Optimizado para celulares inteligentes, tabletas, portátiles y monitores de escritorio.
- **Operación Offline Total**: Equipado con Service Worker e IndexedDB para funcionar sin conexión a internet tras la primera carga.
- **Filtrado por Centro de Salud CCSS**: Permite a cualquier centro periférico consultar exactamente cuáles análisis tiene autorizados para enviar al HSJD.
- **Depuración Clínica**: Omite automáticamente textos genéricos y no informativos (*"Sin indicación"*, *"Flebotomía sin indicación"*).
- **Modo Administrador**: Permite edición local, respaldo y restauración mediante PIN (por defecto: `1234`).

## Instrucciones para Publicar en GitHub Pages

1. Suba todo el contenido de esta carpeta a su repositorio en GitHub (rama `main` o `gh-pages`).
2. En GitHub, diríjase a **Settings** > **Pages**.
3. En **Build and deployment** > **Source**, seleccione **Deploy from a branch**.
4. Elija la rama `main` y la carpeta `/ (root)`. Haga clic en **Save**.
5. En unos segundos, su PWA estará publicada y lista para instalar en cualquier dispositivo.
