# Auditoría inicial de Firestore Rules

## Hallazgos
- `myRole()` depende de `get()` repetido en reglas
- `fcmToken` permitido pero sin validación específica
- `usuarios/{uid}` permite updates amplios al owner
- `canPublish()` mezcla rol y cargos

## Riesgo
- Medio en mantenibilidad
- Medio en costo/rendimiento
- Bajo a medio en seguridad inmediata

## Próximos pasos
1. Evaluar helper `myUser()`
2. Fortalecer validación de `fcmToken`
3. Revisar campos exactos editables por owner
4. Definir política entre `rol` y `cargos`