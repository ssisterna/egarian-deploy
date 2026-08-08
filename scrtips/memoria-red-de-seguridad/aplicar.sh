#!/usr/bin/env bash
# Red de seguridad de memoria del server. NO reinicia ningun servicio.
#
# Hace dos cosas, las dos reversibles:
#   1. Crea un swapfile de 2 GB con swappiness=10.
#   2. Protege a mongod del OOM killer, para que si el kernel alguna vez tiene que
#      matar a alguien, no sea la base de datos.
#
# Por que hace falta, medido en este server el 2026-08-08:
#   - NO hay swap. Sin swap el kernel no tiene margen: cuando aprieta, mata directo.
#   - Si matara, mataria a mongod: es el de oom_score mas alto (781, contra 731 de la
#     api). Una base muerta a mitad de una escritura es MUCHO peor que una app que se
#     reinicia sola con pm2.
#
# Por que swappiness=10 y solo 2 GB: el disco de este server da 4 MB/s en lectura
# aleatoria de 4k, que es justo el patron de acceso del swap. Con el 60 que trae por
# defecto, el kernel swapearia de forma proactiva y se notaria la lentitud sin ningun
# beneficio. Con 10 lo usa solo bajo presion real. Y 2 GB es un COLCHON para un pico,
# no un lugar donde el sistema pueda vivir: con este disco, un sistema profundamente
# swapeado se arrastra igual.
#
# Uso:
#   ./aplicar.sh            -> simula, no toca nada (por defecto)
#   ./aplicar.sh --aplicar  -> aplica de verdad
#   ./aplicar.sh --revertir -> deshace todo
#
# Idempotente: se puede correr las veces que haga falta.

set -euo pipefail

SWAPFILE=/swapfile
TAMANIO=2G
SWAPPINESS=10
SYSCTL_CONF=/etc/sysctl.d/99-egarian-swap.conf
DROPIN_DIR=/etc/systemd/system/mongod.service.d
DROPIN=$DROPIN_DIR/oom.conf
OOM_ADJ=-500

MODO=simulacion
case "${1:-}" in
  --aplicar)  MODO=aplicar ;;
  --revertir) MODO=revertir ;;
  ""|--simular) MODO=simulacion ;;
  *) echo "Uso: $0 [--aplicar|--revertir]"; exit 1 ;;
esac

if [ "$(id -u)" -ne 0 ]; then echo "ERROR: hay que correrlo como root"; exit 1; fi

decir() { printf '  %s\n' "$*"; }
correr() {
  if [ "$MODO" = simulacion ]; then decir "[simulacion] $*"; else eval "$@"; fi
}

echo ""
echo "=== Estado actual ==="
decir "RAM       : $(free -m | awk 'NR==2{print $3" MB en uso de "$2" MB, "$7" MB disponible"}')"
decir "swap      : $(swapon --show=NAME --noheadings 2>/dev/null | tr '\n' ' ' | sed 's/^$/ninguno/')"
decir "swappiness: $(cat /proc/sys/vm/swappiness)"
decir "disco /   : $(df -h / | awk 'NR==2{print $4" libres de "$2}')"
if pgrep -x mongod >/dev/null; then
  MPID=$(pgrep -x mongod | head -1)
  decir "mongod    : oom_score=$(cat /proc/$MPID/oom_score) oom_score_adj=$(cat /proc/$MPID/oom_score_adj)"
fi
echo ""

if [ "$MODO" = revertir ]; then
  echo "=== Revirtiendo ==="
  if swapon --show=NAME --noheadings 2>/dev/null | grep -q "^$SWAPFILE$"; then
    correr "swapoff $SWAPFILE"; decir "swap desactivado"
  fi
  [ -f "$SWAPFILE" ] && { correr "rm -f $SWAPFILE"; decir "swapfile borrado"; }
  correr "sed -i '\\|^$SWAPFILE |d' /etc/fstab"; decir "entrada de fstab quitada"
  [ -f "$SYSCTL_CONF" ] && { correr "rm -f $SYSCTL_CONF"; correr "sysctl -w vm.swappiness=60 >/dev/null"; decir "swappiness vuelto a 60"; }
  [ -f "$DROPIN" ] && { correr "rm -f $DROPIN"; correr "rmdir --ignore-fail-on-non-empty $DROPIN_DIR"; correr "systemctl daemon-reload"; decir "proteccion de mongod quitada (aplica al proximo arranque de mongod)"; }
  if pgrep -x mongod >/dev/null; then correr "echo 0 > /proc/$(pgrep -x mongod | head -1)/oom_score_adj"; decir "oom_score_adj de mongod vuelto a 0 en caliente"; fi
  echo ""; decir "listo. Nada se reinicio."
  exit 0
fi

echo "=== 1. Swapfile de $TAMANIO ==="
if swapon --show=NAME --noheadings 2>/dev/null | grep -q "^$SWAPFILE$"; then
  decir "ya esta activo, no se toca (idempotente)"
else
  # fallocate no sirve en algunos filesystems para swap; dd es el camino seguro.
  correr "fallocate -l $TAMANIO $SWAPFILE || dd if=/dev/zero of=$SWAPFILE bs=1M count=2048 status=none"
  correr "chmod 600 $SWAPFILE"   # adentro hay memoria de procesos: solo root
  correr "mkswap $SWAPFILE >/dev/null"
  correr "swapon $SWAPFILE"
  decir "swapfile creado y activado"
fi
if grep -qs "^$SWAPFILE " /etc/fstab; then
  decir "fstab ya lo tiene, no se duplica"
else
  correr "printf '%s none swap sw 0 0\\n' $SWAPFILE >> /etc/fstab"
  decir "agregado a fstab (sobrevive al reboot)"
fi

echo ""
echo "=== 2. swappiness=$SWAPPINESS ==="
if [ -f "$SYSCTL_CONF" ] && grep -q "vm.swappiness=$SWAPPINESS" "$SYSCTL_CONF"; then
  decir "ya configurado"
else
  correr "printf 'vm.swappiness=%s\\n' $SWAPPINESS > $SYSCTL_CONF"
  decir "escrito en $SYSCTL_CONF (persistente)"
fi
correr "sysctl -w vm.swappiness=$SWAPPINESS >/dev/null"
decir "aplicado en caliente"

echo ""
echo "=== 3. Proteger a mongod del OOM killer ==="
if [ -f "$DROPIN" ] && grep -q "OOMScoreAdjust=$OOM_ADJ" "$DROPIN"; then
  decir "el drop-in de systemd ya existe"
else
  correr "mkdir -p $DROPIN_DIR"
  correr "printf '[Service]\\nOOMScoreAdjust=%s\\n' $OOM_ADJ > $DROPIN"
  correr "systemctl daemon-reload"
  decir "drop-in creado: mongod arranca protegido de aca en mas"
fi
# Y en caliente, para el proceso que ya esta corriendo (sin reiniciarlo).
if pgrep -x mongod >/dev/null; then
  correr "echo $OOM_ADJ > /proc/$(pgrep -x mongod | head -1)/oom_score_adj"
  decir "aplicado tambien al mongod que ya esta corriendo, sin reiniciarlo"
fi

echo ""
echo "=== Estado final ==="
if [ "$MODO" = simulacion ]; then
  decir "MODO SIMULACION: no se toco nada. Correr con --aplicar para hacerlo de verdad."
else
  decir "swap       : $(free -m | awk 'NR==3{print $2" MB total, "$3" MB en uso"}')"
  decir "swappiness : $(cat /proc/sys/vm/swappiness)"
  if pgrep -x mongod >/dev/null; then
    MPID=$(pgrep -x mongod | head -1)
    decir "mongod     : oom_score=$(cat /proc/$MPID/oom_score) oom_score_adj=$(cat /proc/$MPID/oom_score_adj)  (mas bajo = el kernel lo elige despues)"
  fi
  decir "ningun servicio fue reiniciado"
fi
echo ""
