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
# se guardo la ultima vez que npm install corrio bien (marcador .deploy-deps.hash). El install
# corre solo cuando cambian de verdad las dependencias declaradas, sin importar en que estado
# quedo el archivo en disco.
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

  if [ ! -d "node_modules" ]; then
    echo "[$PROJECT_NAME] No hay node_modules. Ejecutando $NPM_INSTALL ..."
    $NPM_INSTALL
    printf '%s\n' "$DEPS_NEW" > "$DEPS_MARKER"
    DEPS_ACTION="npm install (sin node_modules)"
  elif [ "$DEPS_OLD" != "$DEPS_NEW" ]; then
    if [ "$DEPS_OLD" = "__first_deploy__" ]; then
      echo "[$PROJECT_NAME] Sin marcador de dependencias previo. Ejecutando $NPM_INSTALL ..."
      DEPS_ACTION="npm install (1er deploy)"
    else
      echo "[$PROJECT_NAME] Cambiaron las dependencias declaradas en el zip. Ejecutando $NPM_INSTALL ..."
      DEPS_ACTION="npm install (deps nuevas)"
    fi
    $NPM_INSTALL
    # El marcador se escribe DESPUES del install: si falla, el proximo deploy lo reintenta.
    printf '%s\n' "$DEPS_NEW" > "$DEPS_MARKER"
  else
    DEPS_ACTION="sin cambios"
    echo "[$PROJECT_NAME] Dependencias sin cambios. No se ejecuta npm install."
  fi

  rm -f "$ZIP_FILE"

  echo "[$PROJECT_NAME] ********** ACTUALIZACION FINALIZADA **********"
  echo "[$PROJECT_NAME] Reiniciando servicio PM2..."
  # deploy_project corre bajo `if ! deploy_project`, asi que `set -e` NO aborta acá: si pm2 falla
  # hay que capturarlo a mano o el resumen mentiria diciendo que el servicio se reinicio.
  pm2 flush "$PROJECT_NAME" || true
  if pm2 restart "$PROJECT_NAME"; then
    PM2_STATUS="reiniciado"
  else
    PM2_STATUS="ERROR AL REINICIAR"
    echo "[$PROJECT_NAME] pm2 restart FALLO. El codigo nuevo esta en disco pero el proceso viejo sigue vivo."
    add_summary_row "$PROJECT_NAME" "$PROJECT_VERSION" "$FILE_COUNT" "$DEPS_ACTION" "$PM2_STATUS"
    return 1
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
