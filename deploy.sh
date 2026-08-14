#!/bin/sh

set -eu

DEPLOY_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
ROOT_DIR=$(dirname "$DEPLOY_DIR")
DEFAULT_PROJECTS="egarian-api egarian-store egarian-erp"
UPDATED_PROJECTS=""
SKIPPED_PROJECTS=""
FAILED_PROJECTS=""

# Huella de las dependencias DECLARADAS EN EL ZIP (no las del disco).
#
# Antes esto comparaba package.json/package-lock.json en disco antes vs despues de descomprimir.
# Era fragil: cualquier cosa que reescriba el package.json del servidor (un npm install manual, un
# audit fix, una normalizacion de npm) lo deja distinto al del zip PARA SIEMPRE, y entonces el
# script detecta un "cambio" en cada deploy y corre npm install eternamente.
#
# Ahora se compara la huella del package.json/package-lock.json QUE VIENE EN EL ZIP contra la que
# se guardo la ultima vez que las dependencias se instalaron (marcador .deploy-deps.hash), sin
# importar en que estado quedo el archivo en disco.
#
# Cuando la huella cambia, el deploy instala SOLO SI el zip trae package-lock.json: con lock el
# install no re-resuelve nada, aplica el arbol exacto que se validó en desarrollo. Sin lock avisa
# y lo instalas vos, porque ahi si resolveria de nuevo contra el registry (lento e impredecible).
# Si la huella no cambio, no instala nunca. Ver el bloque de instalacion mas abajo.
DEPS_MARKER=".deploy-deps.hash"

# Produccion NO necesita las devDependencies: el servidor no compila ni testea nada, recibe el
# dist/ ya compilado y arranca con `node dist/index.js`. Las devDeps son @types (solo compilan),
# typescript, vitest, supertest, nodemon, husky, y pesos muertos como mongodb-memory-server (que
# se baja un binario de Mongo entero en su postinstall) o puppeteer-core.
# Verificado: ningun archivo de dist/ requiere una devDependency (el unico require de ts-node,
# en el worker.entry del API, esta detras de un guard que solo aplica corriendo desde src/).
NPM_INSTALL="npm install --omit=dev"

zip_deps_fingerprint() {
  ZIP="$1"
  for entry in package.json package-lock.json; do
    if unzip -Z1 "$ZIP" | grep -qx "$entry"; then
      printf '%s:' "$entry"
      unzip -p "$ZIP" "$entry" | cksum | awk '{ print $1 ":" $2 }'
    else
      printf '%s:__absent__\n' "$entry"
    fi
  done
}

zip_has_unsafe_paths() {
  unzip -Z1 "$1" | awk '
    $0 ~ /^\// { found = 1 }
    $0 ~ /(^|\/)\.\.(\/|$)/ { found = 1 }
    END { exit found ? 0 : 1 }
  '
}

# Version desplegada, leida del version.json que vino en el zip (MAJOR.MINOR.PATCH.BUILD).
read_version() {
  if [ -f "version.json" ]; then
    sed -n 's/.*"version"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' version.json | head -1
  else
    echo "?"
  fi
}

# Una linea por repo para el resumen final: nombre|version|archivos|dependencias|servicio
SUMMARY_ROWS=""
add_summary_row() {
  SUMMARY_ROWS="${SUMMARY_ROWS}$1|$2|$3|$4|$5
"
}

deploy_project() {
  PROJECT_NAME=$1
  ZIP_FILE="$DEPLOY_DIR/$PROJECT_NAME.zip"
  PROJECT_DIR="$ROOT_DIR/$PROJECT_NAME"

  if [ ! -f "$ZIP_FILE" ]; then
    echo "[$PROJECT_NAME] No existe $PROJECT_NAME.zip. Saltando."
    SKIPPED_PROJECTS="$SKIPPED_PROJECTS $PROJECT_NAME"
    return 0
  fi

  if [ ! -d "$PROJECT_DIR" ]; then
    echo "[$PROJECT_NAME] No existe el directorio $PROJECT_DIR."
    return 1
  fi

  echo "[$PROJECT_NAME] ********** INICIANDO ACTUALIZACION **********"

  if zip_has_unsafe_paths "$ZIP_FILE"; then
    echo "[$PROJECT_NAME] El zip contiene rutas inseguras. Abortando."
    return 1
  fi

  unzip -tq "$ZIP_FILE" >/dev/null

  cd "$PROJECT_DIR"

  DEPS_NEW=$(zip_deps_fingerprint "$ZIP_FILE")
  if [ -f "$DEPS_MARKER" ]; then
    DEPS_OLD=$(cat "$DEPS_MARKER")
  else
    DEPS_OLD="__first_deploy__"
  fi

  TOP_LEVEL=$(unzip -Z1 "$ZIP_FILE" | awk -F/ 'NF { print $1 }' | sort -u)

  for top in $TOP_LEVEL; do
    case "$top" in
      ""|"."|"..")
        echo "[$PROJECT_NAME] Entrada invalida en el zip: $top"
        return 1
        ;;
      "assets")
        echo "[$PROJECT_NAME] Conservando assets existentes; unzip actualizara archivos incluidos."
        continue
        ;;
    esac

    if [ -d "$top" ] || [ -f "$top" ]; then
      echo "[$PROJECT_NAME] Eliminando $top ..."
      rm -rf "$top"
    fi
  done

  FILE_COUNT=$(unzip -Z1 "$ZIP_FILE" | wc -l | tr -d ' ')

  unzip -o "$ZIP_FILE"

  PROJECT_VERSION=$(read_version)

  # ────────────────────────────────────────────
  # Instalacion de dependencias.
  #
  # Historia: esto NO instalaba solo, avisaba y lo corrias a mano. El motivo era que
  # `npm install` SIN lockfile vuelve a resolver todo el arbol contra el registry, y eso
  # en cada deploy es lento y riesgoso.
  #
  # Desde 2026-08-06 los zips traen el package-lock.json, y con lock el install deja de
  # ser una reresolucion: instala EXACTAMENTE el arbol bloqueado, que es el que se validó
  # en desarrollo. O sea que el motivo del freno ya no aplica cuando viene lock.
  #
  # Regla: si el zip trae lock -> instala solo (determinista). Si no trae -> avisa, como antes.
  # Asi no hay que adivinar ninguna variable de entorno: el script decide con lo que tiene.
  #   DEPLOY_SKIP_DEPS=1     -> nunca instala, solo avisa (para deployar sin tocar deps)
  #   DEPLOY_INSTALL_DEPS=1  -> instala aunque no venga lock (compatibilidad hacia atras)
  # ────────────────────────────────────────────
  case "$DEPS_NEW" in
    *"package-lock.json:__absent__"*) ZIP_HAS_LOCK=0 ;;
    *)                                ZIP_HAS_LOCK=1 ;;
  esac

  DEPS_PENDING=0
  if [ ! -d "node_modules" ]; then
    echo "[$PROJECT_NAME] No hay node_modules (el servicio no podria arrancar). Ejecutando $NPM_INSTALL ..."
    $NPM_INSTALL
    printf '%s\n' "$DEPS_NEW" > "$DEPS_MARKER"
    DEPS_ACTION="npm install (sin node_modules)"
  elif [ "$DEPS_OLD" != "$DEPS_NEW" ]; then
    if [ "${DEPLOY_SKIP_DEPS:-0}" = "1" ]; then
      echo "[$PROJECT_NAME] *** CAMBIARON LAS DEPENDENCIAS *** (DEPLOY_SKIP_DEPS=1: no se instala)"
      echo "[$PROJECT_NAME] Corre a mano, en $PROJECT_DIR:"
      echo "[$PROJECT_NAME]     $NPM_INSTALL && printf '%s\\n' '$DEPS_NEW' > $DEPS_MARKER"
      DEPS_ACTION="DEPS NUEVAS - instalar a mano"
      DEPS_PENDING=1
    elif [ "$ZIP_HAS_LOCK" = "1" ] || [ "${DEPLOY_INSTALL_DEPS:-0}" = "1" ]; then
      if [ "$ZIP_HAS_LOCK" = "1" ]; then
        echo "[$PROJECT_NAME] Cambiaron las dependencias. El zip trae package-lock.json, asi que el install"
        echo "[$PROJECT_NAME] es determinista (instala el arbol validado). Ejecutando $NPM_INSTALL ..."
      else
        echo "[$PROJECT_NAME] Cambiaron las dependencias y DEPLOY_INSTALL_DEPS=1. Ejecutando $NPM_INSTALL ..."
      fi
      # El marcador se escribe DESPUES del install: si falla, el proximo deploy lo reintenta.
      if $NPM_INSTALL; then
        printf '%s\n' "$DEPS_NEW" > "$DEPS_MARKER"
        DEPS_ACTION="npm install (deps nuevas)"
      else
        echo "[$PROJECT_NAME] *** EL npm install FALLO *** El marcador NO se escribe: el proximo deploy reintenta."
        DEPS_ACTION="npm install FALLO"
        DEPS_PENDING=1
      fi
    else
      echo "[$PROJECT_NAME] *** CAMBIARON LAS DEPENDENCIAS Y EL ZIP NO TRAE package-lock.json ***"
      echo "[$PROJECT_NAME] Sin lock, el install re-resuelve el arbol contra el registry: se deja en tus manos."
      echo "[$PROJECT_NAME] Corre a mano, en $PROJECT_DIR:"
      echo "[$PROJECT_NAME]     $NPM_INSTALL && printf '%s\\n' '$DEPS_NEW' > $DEPS_MARKER"
      echo "[$PROJECT_NAME] O volve a deployar con: DEPLOY_INSTALL_DEPS=1 ./deploy.sh $PROJECT_NAME"
      DEPS_ACTION="DEPS NUEVAS - instalar a mano"
      DEPS_PENDING=1
    fi
  else
    DEPS_ACTION="sin cambios"
    echo "[$PROJECT_NAME] Dependencias sin cambios. No se ejecuta npm install."
  fi

  # El zip se borra solo si el deploy quedo completo. Si las dependencias quedaron
  # pendientes se CONSERVA, para poder reintentar sin volver a subirlo (antes se borraba
  # siempre y el reintento obligaba a re-subir el zip desde la maquina de desarrollo).
  if [ "$DEPS_PENDING" = "1" ]; then
    echo "[$PROJECT_NAME] Se conserva $ZIP_FILE para poder reintentar: ./deploy.sh $PROJECT_NAME"
  else
    rm -f "$ZIP_FILE"
  fi

  echo "[$PROJECT_NAME] ********** ACTUALIZACION FINALIZADA **********"
  echo "[$PROJECT_NAME] Reiniciando servicio PM2..."
  # deploy_project corre bajo `if ! deploy_project`, asi que `set -e` NO aborta acá: si pm2 falla
  # hay que capturarlo a mano o el resumen mentiria diciendo que el servicio se reinicio.
  if [ "$PROJECT_NAME" = "egarian-api" ] && pm2 describe egarian-api-scheduler >/dev/null 2>&1; then
    # Topologia multi-instancia del api (ver ecosystem.config.js): el SCHEDULER va
    # PRIMERO (aplica las migraciones nuevas y recien entonces avisa ready) y despues
    # el reload ROLLING de las web, que arrancan con el esquema ya al dia. Al reves
    # las web nuevas esperan migraciones que el scheduler viejo no conoce y ciclan
    # por timeout. Las web viejas siguen sirviendo durante todo el proceso: cero caida.
    pm2 flush egarian-api-scheduler || true
    pm2 flush egarian-api || true
    if pm2 restart egarian-api-scheduler && pm2 reload egarian-api; then
      PM2_STATUS="scheduler reiniciado + web recargadas"
    else
      PM2_STATUS="ERROR AL REINICIAR"
      echo "[$PROJECT_NAME] pm2 FALLO (scheduler o web). El codigo nuevo esta en disco; revisar: pm2 ls && pm2 logs"
      add_summary_row "$PROJECT_NAME" "$PROJECT_VERSION" "$FILE_COUNT" "$DEPS_ACTION" "$PM2_STATUS"
      return 1
    fi
  else
    if [ "$PROJECT_NAME" = "egarian-api" ]; then
      echo "[$PROJECT_NAME] AVISO: no existe el proceso egarian-api-scheduler (topologia multi-instancia sin instalar)."
      echo "[$PROJECT_NAME] Se hace un reinicio simple. Para instalar la topologia (corte breve, hacerlo en horario tranquilo):"
      echo "[$PROJECT_NAME]     pm2 delete egarian-api && pm2 start $ROOT_DIR/ecosystem.config.js && pm2 save"
    fi
    pm2 flush "$PROJECT_NAME" || true
    if pm2 restart "$PROJECT_NAME"; then
      PM2_STATUS="reiniciado"
    else
      PM2_STATUS="ERROR AL REINICIAR"
      echo "[$PROJECT_NAME] pm2 restart FALLO. El codigo nuevo esta en disco pero el proceso viejo sigue vivo."
      add_summary_row "$PROJECT_NAME" "$PROJECT_VERSION" "$FILE_COUNT" "$DEPS_ACTION" "$PM2_STATUS"
      return 1
    fi
  fi

  UPDATED_PROJECTS="$UPDATED_PROJECTS $PROJECT_NAME"
  add_summary_row "$PROJECT_NAME" "$PROJECT_VERSION" "$FILE_COUNT" "$DEPS_ACTION" "$PM2_STATUS"
}

if [ "$#" -gt 0 ]; then
  PROJECTS="$*"
else
  PROJECTS="$DEFAULT_PROJECTS"
fi

DEPLOYED=0

for project in $PROJECTS; do
  case "$project" in
    egarian-api|egarian-store|egarian-erp)
      if [ -f "$DEPLOY_DIR/$project.zip" ]; then
        DEPLOYED=1
      fi
      if ! deploy_project "$project"; then
        FAILED_PROJECTS="$FAILED_PROJECTS $project"
      fi
      ;;
    *)
      echo "Proyecto no soportado: $project"
      exit 1
      ;;
  esac
done

if [ "$DEPLOYED" -eq 0 ]; then
  echo "No se encontro ningun zip para desplegar en $DEPLOY_DIR."
fi

echo ""
echo "=========================== RESUMEN DE DEPLOY ==========================="
if [ -n "$SUMMARY_ROWS" ]; then
  printf '%-14s %-12s %-9s %-30s %s\n' "REPO" "VERSION" "ARCHIVOS" "DEPENDENCIAS" "SERVICIO"
  printf '%s\n' "------------------------------------------------------------------------"
  printf '%s' "$SUMMARY_ROWS" | while IFS='|' read -r name version files deps status; do
    [ -n "$name" ] || continue
    printf '%-14s %-12s %-9s %-30s %s\n' "$name" "v$version" "$files" "$deps" "$status"
  done
else
  echo "Actualizados: ninguno"
fi

if [ -n "$SKIPPED_PROJECTS" ]; then
  echo ""
  echo "Sin zip (no se desplegaron):$SKIPPED_PROJECTS"
fi

if [ -n "$FAILED_PROJECTS" ]; then
  echo ""
  echo "CON ERROR:$FAILED_PROJECTS"
  echo "========================================================================"
  exit 1
fi

echo "========================================================================"
