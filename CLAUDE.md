# Club de Leones Veracruz A.C. — PWA

## Proyecto
PWA completa del Club de Leones Veracruz A.C., accesible en https://app-club-de-leones.web.app

## Archivo principal
`public/index.html` — toda la app vive en este único archivo. No crear archivos adicionales salvo que sea estrictamente necesario.

## Stack técnico
- **Firebase:** proyecto `app-club-de-leones`, Firestore en `nam5`, Functions en `us-central1`, Hosting
- **Imágenes:** Cloudinary, cloud name `dgfkkwypy`, preset `club-leones`
- **Notificaciones:** Firebase Cloud Messaging (FCM), entrega en iOS bajo investigación

## Cloud Functions activas
- `notificarNuevoComunicado`
- `notificarSocioAprobado`
- `notificarSolicitudCargo`
- `notificarPagoMutualista`
- `notificarAdeudoManual`

## Roles del sistema
`admin`, `subadmin`, `Presidente`, `Secretario`, `Tesorero`, `Cantinero`, `Mutualista`, `Socio`, `Dama León`, `Viuda`, `Cooperadora`, `Empleado`

## Módulos y funciones clave
- Sistema de roles y permisos granulares
- Fondo Mutualista (vista financiera)
- Mis Recibos (vista para socios individuales)
- Panel de Finanzas (solo escritorio, solo admin)
- Huella digital (auditoría completa de acciones)
- Indicadores de deuda con colores
- Pull-to-refresh con barra indicadora dorada
- Modal de impresión selectiva de recibos (`dp-modal-imprimir-sel`)

## Reglas de trabajo
1. Leer siempre la sección relevante del archivo antes de modificar
2. Todos los cambios van dentro de `public/index.html`
3. Al terminar cambios, preguntar si se debe correr `firebase deploy`
4. No romper funcionalidad existente al agregar features nuevas
5. Respetar la estructura de roles y permisos en cada nueva función

## Workflow de deploy
```bash
cd ~/club-leones
firebase deploy
```
