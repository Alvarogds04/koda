#!/bin/sh
# Windows 11 test VM for the Abito island Windows port (unit U5).
#
# Why qemu:///system and not the session URI (measured, not guessed): on this
# host QEMU 10 fails to start as an unprivileged user about half the time with
# "Failed to initialize io_uring: Cannot allocate memory" (4/8 clean starts, and
# libvirt's capability probe then reports that the host supports no
# virtualization). The same binary as root starts 8/8. Raising RLIMIT_MEMLOCK
# does not change the rate, so the rootless session connection is not usable
# here. Every command therefore goes through `sudo virsh/virt-install` on
# qemu:///system and the disk lives in the pool the human named as allowed:
# /var/lib/libvirt/images. Nothing else on the host is touched: no group
# membership change, no sysctl, no service enable/disable.
#
#   sh vm.sh check              # host guards + what the host offers
#   sh vm.sh create             # answer CD + disk + define + start the install
#   sh vm.sh status             # domain state, guest IP
#   sh vm.sh console            # attach to COM1 (Windows setup / ABITO-CMD log)
#   sh vm.sh send <comando>     # queue a cmd.exe command for the guest, run it
#   sh vm.sh shell              # interactive: queue + wait + print each result
#   sh vm.sh inbox              # what the guest has pushed back
#   sh vm.sh stop | destroy     # ACPI shutdown / hard stop
#   sh vm.sh purge              # destroy + undefine + delete disk (ISO kept)
#
# Control channels with the guest (the guest never accepts an inbound
# connection; OpenSSH server is only a best-effort bonus):
#   IN   a tiny ISO (label ABITO_SETUP) is rebuilt with command-<N>.bat and
#        hot-swapped as the second CD-ROM. C:\abito\vm-poll.ps1, running as the
#        AbitoPortPoll scheduled task, sees a new number and executes it.
#   OUT  each result is POSTed to the collect listener on 192.168.122.1:8765
#        (the libvirt NAT gateway, host side), echoed to COM1, and kept in
#        C:\abito\out-<N>.txt inside the guest.
set -eu

NAME=${ABITO_VM_NAME:-abito-win11}
URI=qemu:///system
VMHOME=${ABITO_VM_HOME:-$HOME/.local/share/abito-vm}
ISO=${ABITO_WIN_ISO:-$VMHOME/iso/Win11_25H2_consumer_x64_en-us.iso}
SRCDIR=$(dirname "$0")
UNATTEND=$SRCDIR/win11-autounattend.xml
SETUP_PS1=$SRCDIR/vm-setup.ps1
POLL_PS1=$SRCDIR/vm-poll.ps1
COLLECT=$SRCDIR/collect-server.py
POOLDIR=${ABITO_VM_POOL:-/var/lib/libvirt/images}
MEMORY_MB=${ABITO_VM_MEMORY_MB:-8192}
VCPU=${ABITO_VM_VCPUS:-4}
DISK_GB=${ABITO_VM_DISK_GB:-64}
INBOX=$VMHOME/inbox
GATEWAY=192.168.122.1
COLLECT_PORT=8765
MAX_HOST_MEMORY_USED_PCT=75
MAX_HOST_RAM_GB=16   # never hand this VM more than that without asking the human

say() { printf '%s\n' "$*"; }
die() { printf 'FALLO: %s\n' "$*" >&2; exit 1; }
vir() { sudo -n virsh -c "$URI" "$@"; }
vinst() { sudo -n virt-install --connect "$URI" "$@"; }

check() {
  [ -e /dev/kvm ] || die "/dev/kvm no existe: sin KVM no hay VM que sirva"
  say "/dev/kvm presente; grupo kvm del usuario: $(id -nG | grep -qw kvm && echo si || echo NO)"
  total=$(free -g | awk '/^Mem:/{print $2}')
  avail=$(free -g | awk '/^Mem:/{print $7}')
  used=$((100 - avail * 100 / total))
  say "RAM: ${total} GB total, ${avail} GB disponibles, ${used}% usada"
  [ "$used" -le "$MAX_HOST_MEMORY_USED_PCT" ] || die "el host usa el ${used}% de su RAM; no le robo ${MEMORY_MB} MB"
  [ "$MEMORY_MB" -le $((MAX_HOST_RAM_GB * 1024)) ] || die "${MEMORY_MB} MB exceden el tope de ${MAX_HOST_RAM_GB} GB para esta VM"
  say "CPU: $(nproc) hilos"
  free_gb=$(df -BG --output=avail "$POOLDIR" 2>/dev/null | tail -1 | tr -dc '0-9')
  [ -n "${free_gb:-}" ] || free_gb=$(df -BG --output=avail / | tail -1 | tr -dc '0-9')
  need=$((DISK_GB + 12))
  say "disco donde vive el pool: ${free_gb} GB libres"
  [ "$free_gb" -ge "$need" ] || die "hacen falta ${need} GB libres y sólo hay ${free_gb} GB"
  [ -f "$ISO" ] || die "falta la ISO en $ISO"
  say "ISO: $ISO ($(stat -c %s "$ISO") bytes)"
  [ -f "$ISO.sha256" ] && say "sha256 registrado: $(cat "$ISO.sha256")"
  swtpm --version | sed 's/^/swtpm: /'
  say "conexión de sistema: $(vir domcapabilities --virttype kvm 2>&1 | grep -q '<domainCapabilities' && echo 'sondea OK' || echo 'sondeo FALLÓ')"
  vir list --all | sed 's/^/  dominio: /'
}

# Windows Setup reads an answer file only from the root of removable media, and
# the guest's poll task reads command-<N>.bat from the same volume.
make_command_iso() {
  cmdn=${1:-0}
  [ -f "$UNATTEND" ] || die "falta $UNATTEND"
  [ -f "$SETUP_PS1" ] || die "falta $SETUP_PS1"
  [ -f "$POLL_PS1" ] || die "falta $POLL_PS1"
  rm -rf "$VMHOME/cd"
  mkdir -p "$VMHOME/cd"
  cp "$UNATTEND" "$VMHOME/cd/autounattend.xml"
  cp "$SETUP_PS1" "$VMHOME/cd/vm-setup.ps1"
  cp "$POLL_PS1" "$VMHOME/cd/vm-poll.ps1"
  if [ "$cmdn" -gt 0 ]; then
    shift
    cat > "$VMHOME/cd/command-$cmdn.bat" <<CMDS
@echo off
$*
CMDS
  fi
  ( cd "$VMHOME/cd" && xorriso -as mkisofs -o "$VMHOME/cd.iso" -V ABITO_SETUP -J -r . ) >/dev/null
  say "command.iso: $(stat -c %s "$VMHOME/cd.iso") bytes (autounattend + vm-setup + vm-poll + command-$cmdn)"
}

POOLMEDIA=${ABITO_VM_POOLMEDIA:-/var/lib/libvirt/abito-vm}

# libvirt reads the media as user libvirt-qemu, so the answer CD has to live
# under a directory that user can reach. Keep one copy in the repo-adjacent VM
# home (for building) and one in the pool (for the domain).
sync_cd() {
  sudo -n mkdir -p "$POOLMEDIA/iso"
  sudo -n cp -f "$VMHOME/cd.iso" "$POOLMEDIA/$NAME-cd.iso"
  sudo -n chmod a+r "$POOLMEDIA/$NAME-cd.iso" "$POOLMEDIA/iso" 2>/dev/null || true
  if [ ! -f "$POOLMEDIA/iso/$(basename "$ISO")" ]; then
    say "# copiando la ISO de Windows a $POOLMEDIA/iso (7,7 GB, un minuto)"
    sudo -n cp -f "$ISO" "$POOLMEDIA/iso/"
    sudo -n chmod a+r "$POOLMEDIA/iso/$(basename "$ISO")"
  fi
  say "CD de respuesta sincronizado a $POOLMEDIA/$NAME-cd.iso"
}

create() {
  command -v virt-install >/dev/null || die "virt-install no está instalado"
  make_command_iso 0
  # libvirt runs qemu as root; make media accessible for libvirt-qemu too.
  chmod a+rX "$VMHOME" "$VMHOME/iso" "$VMHOME/cd" 2>/dev/null || true
  mkdir -p "$INBOX"
  say "# dominio $NAME: ${MEMORY_MB} MB, ${VCPU} vCPU, disco ${DISK_GB} GB en $POOLDIR"
  # 1) Create the disk (sparse).
  qemu-img create -f qcow2 "$POOLDIR/$NAME.qcow2" "$DISK_GB" 2>/dev/null | tail -1
  say "disco $POOLDIR/$NAME.qcow2 creado (sparse, $DISK_GB GB)"
  # 2) Put the media where libvirt-qemu can read it.
  sync_cd
  # 3) Define from the hand-written XML (TPM emulator, UEFI, in-box drivers).
  sudo -n virsh -c "$URI" define "$SRCDIR/abito-win11-domain.xml"
  say "dominio definido desde $SRCDIR/abito-win11-domain.xml"
  say "dominio definido"
  # 3) Start.
  sudo -n virsh -c "$URI" start "$NAME"
  say "# arrancando. Esperá ~40 min al boot final."
  say "  sh vm.sh status         → estado del dominio"
  say "  sh vm.sh console        → ver el arranque (COM1)"
  say "  sh vm.sh inbox          → ver resultados del poll task"
  say "  sh vm.sh send <comando> → encolar comando cmd.exe"
}

status() {
  vir dominfo "$NAME" 2>/dev/null | sed 's/^/  /' || die "$NAME no está definido"
  say "--- lease en la red NAT ---"
  vir net-dhcp-lease default 2>/dev/null | sed -n '1,12p' || say "  (sin leases; el guest aún no arrancó o no pidió DHCP)"
  say "--- inbox del collect ---"
  ls -1 "$INBOX" 2>/dev/null | sed 's/^/  /' || say "  vacío"
}

console() { exec sudo -n virsh -c "$URI" console "$NAME" --force-console-keys; }

collect_up() {
  if sudo -n ss -ltn 2>/dev/null | grep -q "$GATEWAY:$COLLECT_PORT"; then return 0; fi
  [ -f "$COLLECT" ] || die "falta $COLLECT"
  say "# Levanto el listener de collect en $GATEWAY:$COLLECT_PORT"
  nohup python3 "$COLLECT" --listen "$GATEWAY" --port "$COLLECT_PORT" --out "$INBOX" >"$VMHOME/collect.log" 2>&1 &
  sleep 1
}

send() {
  [ $# -ge 1 ] || die "uso: vm.sh send <comando cmd.exe>"
  n=$(cat "$VMHOME/last-cmd" 2>/dev/null || echo 0)
  n=$((n + 1))
  make_command_iso "$n" "$*"
  echo "$n" > "$VMHOME/last-cmd"
  collect_up
  # Hot-swap the second CD-ROM (index 2 in virt-install's layout: cdrom1).
  sync_cd
  tgt=$(vir domblklist "$NAME" 2>/dev/null | awk '$2 ~ /'"$NAME"'-cd\.iso/{print $1; exit}')
  [ -n "${tgt:-}" ] || die "no encuentro el CD de respuesta montado; revisá 'virsh -c $URI domblklist $NAME'"
  vir change-media "$NAME" "$tgt" --eject >/dev/null 2>&1 || true
  vir change-media "$NAME" "$tgt" --live --update "$POOLMEDIA/$NAME-cd.iso" || die "no pude cambiar el CD en $tgt"
  say "# comando $n encolado; el poll task lo ejecuta en hasta 60 s"
  say "# resultado: sh vm.sh inbox   (o C:\\abito\\out-$n.txt dentro del guest)"
}

case "${1:-check}" in
  check) check ;;
  create) create ;;
  status) status ;;
  console) console ;;
  send) shift; send "$@" ;;
  inbox) ls -1t "$INBOX" 2>/dev/null | head -20 ;;
  stop) vir shutdown "$NAME" ;;
  destroy) vir destroy "$NAME" ;;
  purge)
    vir destroy "$NAME" 2>/dev/null || true
    vir undefine "$NAME" --nvram --remove-all-storage || die "undefine falló"
    rm -rf "$VMHOME/cd" "$VMHOME/cd.iso" "$VMHOME/last-cmd"
    say "VM borrada; ISO conservada en $VMHOME/iso"
    ;;
  *) die "uso: vm.sh {check|create|status|console|send|inbox|stop|destroy|purge}" ;;
esac
