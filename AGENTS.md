# Instrucciones para agentes

## Scripts operativos de produccion

Cuando el usuario pida crear un script para ejecutar una correccion, consulta o tarea operativa en produccion, crear un directorio exclusivo para esa tarea dentro de:

```text
D:\Egarian\Desarrollo\deploy\scrtips\<nombre-del-script>\
```

Guardar dentro de ese directorio todos los archivos necesarios para ejecutar la tarea. No dejar el script suelto en la raiz de `deploy` ni directamente dentro de `scrtips`.

El usuario copiara el directorio completo al servidor, debajo de:

```text
/usr/local/etc/deploy/scritps/<nombre-del-script>/
```

El script debe poder ejecutarse estando posicionado dentro de ese directorio remoto. Debe cargar las variables productivas desde:

```text
/usr/local/etc/egarian-api/.env.production
```

Las dependencias compartidas se instalan en `/usr/local/etc/deploy/scritps/node_modules`. Node puede resolverlas desde los scripts ubicados en sus subdirectorios.

Entregar siempre el comando exacto de ejecucion. Para un archivo JavaScript, usar este formato:

```sh
cd /usr/local/etc/deploy/scritps/<nombre-del-script>
node --env-file=/usr/local/etc/egarian-api/.env.production ./<archivo>.js
```

Los scripts que modifiquen datos deben ser idempotentes, validar `MONGO_URL`, informar claramente que base de datos utilizaran, ofrecer modo de simulacion cuando sea viable y cerrar la conexion en un bloque `finally`. No imprimir secretos ni incluir credenciales en los archivos.
