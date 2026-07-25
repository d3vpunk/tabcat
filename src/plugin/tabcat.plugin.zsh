#!/usr/bin/env zsh
# tabcat — chunk-based, learning shell autocomplete, as a zsh plugin.
#
# Talks to `tabcat daemon` over a unix socket held open as a persistent fd
# (~0.03 ms per request). A fork per keystroke — `nc -U`, `socat` — would cost
# ~6 ms and lose all state, which is why zsh/net/socket is a hard requirement.
#
# Everything here fails soft: if the daemon is missing, slow, or speaks another
# protocol, the widgets fall back to plain zsh behaviour. The user's shell must
# never hang because of a completion engine.

# ---------------------------------------------------------------------------
# Guards
# ---------------------------------------------------------------------------

# Non-interactive shells (`zsh -i -c`, scripts) get nothing at all.
[[ -o interactive ]] || return 0

if ! zmodload zsh/net/socket 2>/dev/null; then
  print -u2 "tabcat: zsh/net/socket is unavailable — plugin not loaded."
  return 1
fi
zmodload zsh/datetime 2>/dev/null
zmodload zsh/system 2>/dev/null
zmodload zsh/zselect 2>/dev/null
zmodload zsh/terminfo 2>/dev/null
# menu-select lives in complist; without it `zle -C ... menu-select` errors out.
zmodload zsh/complist 2>/dev/null
autoload -Uz add-zsh-hook read-from-minibuffer

# ---------------------------------------------------------------------------
# Configuration (override before sourcing)
# ---------------------------------------------------------------------------

: ${TABCAT_BIN:=tabcat}
# Socket override, mirroring `tabcat daemon --socket`. Empty = derive it from
# $XDG_RUNTIME_DIR (see _tabcat_socket_path).
: ${TABCAT_SOCKET:=}
# The `^X` family: verified free in a default emacs keymap. Every single Ctrl
# key is taken by zsh itself, so two-stroke chords are the price of not
# breaking anyone's muscle memory.
: ${TABCAT_KEY_LABEL:='^Xl'}
: ${TABCAT_KEY_FORGET:='^Xf'}
: ${TABCAT_KEY_QUERY:='^Xq'}
: ${TABCAT_KEY_MENU:='^Xv'}
: ${TABCAT_GHOST:=1}
: ${TABCAT_GHOST_STYLE:='fg=8'}
: ${TABCAT_BADGE:=1}
: ${TABCAT_MENU_LIMIT:=10}
: ${TABCAT_SEARCH_LIMIT:=10}
# Read timeout in seconds. A wedged daemon must not block the prompt: on
# timeout the fd is dropped and the widget falls back.
: ${TABCAT_TIMEOUT:=0.05}
# Socket polls after an on-demand spawn, 20 ms apart. Deliberately small: a cold
# daemon needs ~0.3-0.6 s until it listens, and blocking a keystroke for that
# long is worse than missing one suggestion. The daemon is normally started at
# plugin load (see _tabcat_warm_daemon), so this path is the exception.
: ${TABCAT_CONNECT_TRIES:=3}
# Start the daemon when the shell starts instead of on the first keystroke.
: ${TABCAT_WARM_ON_LOAD:=1}
# How long a spawn started by ANY shell is considered in flight. Within that
# window a failed connect waits instead of starting another daemon.
: ${TABCAT_SPAWN_GRACE:=3}

typeset -g _TABCAT_PROTOCOL=1
# Declared WITHOUT a value: re-sourcing .zshrc must not reset an open fd, the
# spawn bookkeeping, or the remembered Tab binding — a reset would leak the fd
# and make the Tab fallback point at tabcat-tab itself.
typeset -g _TABCAT_FD
typeset -gi _TABCAT_SEQ
typeset -gi _TABCAT_SPAWNS
typeset -gF _TABCAT_SPAWN_AT
typeset -g _TABCAT_LOCKFD
typeset -g _TABCAT_ORIG_TAB
: ${_TABCAT_FD:=0}
# Re-sourcing is also how a user retries after the plugin disabled itself.
typeset -gi _TABCAT_OFF=0
typeset -g _TABCAT_SOCKET=''
typeset -g _TABCAT_GHOST_TEXT=''
typeset -g _TABCAT_PENDING_LINE=''
typeset -g _TABCAT_PENDING_CWD=''
typeset -ga _TABCAT_ROWS=()
typeset -ga _TABCAT_UNDO_BUFFERS=()
typeset -ga _TABCAT_UNDO_CURSORS=()

# Widgets wrapped so the ghost follows every edit. Same approach as
# zsh-autosuggestions: POSTDISPLAY alone only updates when a bound widget runs,
# so plain typing would never refresh it. Completion widgets are deliberately
# absent — Tab is ours and must not re-enter its own wrapper.
typeset -ga TABCAT_FETCH_WIDGETS=(
  self-insert
  backward-delete-char delete-char
  backward-kill-word kill-word delete-word backward-delete-word
  kill-line backward-kill-line kill-whole-line kill-region
  yank yank-pop
  transpose-chars transpose-words
  forward-char backward-char forward-word backward-word
  beginning-of-line end-of-line
  up-line-or-history down-line-or-history
  up-line-or-beginning-search down-line-or-beginning-search
  history-search-backward history-search-forward
  history-beginning-search-backward history-beginning-search-forward
  undo redo
  bracketed-paste
  magic-space
)

# ---------------------------------------------------------------------------
# Wire helpers (no forks on the hot path)
# ---------------------------------------------------------------------------

# Escapes the four framing characters. Mirrors escapeField() in protocol.ts.
_tabcat_esc() {
  local s=$1
  s=${s//\\/\\\\}
  s=${s//$'\t'/'\t'}
  s=${s//$'\n'/'\n'}
  s=${s//$'\r'/'\r'}
  REPLY=$s
}

# Decodes one field. `${(g::)}` resolves \\ \t \n \r in a single left-to-right
# pass, so the escaped form of a literal backslash-t stays a backslash-t.
_tabcat_dec() {
  local s=$1
  REPLY=${(g::)s}
}

# Mirrors defaultSocketPath() in paths.ts — pinned by a parity test.
_tabcat_socket_path() {
  local dir
  if [[ -n ${XDG_RUNTIME_DIR:-} && -d ${XDG_RUNTIME_DIR:-} ]]; then
    dir=$XDG_RUNTIME_DIR/tabcat
    # 12 = length of '/daemon.sock'; sun_path is 104 bytes on darwin.
    (( ${#dir} + 12 > 100 )) && dir=/tmp/tabcat-$UID
  else
    dir=/tmp/tabcat-$UID
  fi
  REPLY=$dir/daemon.sock
}

_tabcat_disable() {
  (( _TABCAT_OFF )) && return 0
  _TABCAT_OFF=1
  _tabcat_drop_fd
  # $WIDGET only exists inside a zle widget; assigning POSTDISPLAY outside one
  # would just leave a stray global behind.
  (( ${+WIDGET} )) && POSTDISPLAY=''
  print -u2 "tabcat: $1 — plugin disabled for this shell."
  return 0
}

# The redirection is scoped with { }: `exec ... 2>/dev/null` would redirect the
# whole shell's stderr permanently and silence every later command.
_tabcat_drop_fd() {
  if [[ $_TABCAT_FD != 0 ]]; then
    { exec {_TABCAT_FD}>&- } 2>/dev/null
    _TABCAT_FD=0
  fi
}

_tabcat_await_socket() {
  local i
  for (( i = 1; i <= TABCAT_CONNECT_TRIES; i++ )); do
    [[ -S $_TABCAT_SOCKET ]] && return 0
    # 2 centiseconds without forking a `sleep`. zselect exits 1 when its timeout
    # expires, which is the normal case here — not an error.
    zselect -t 2 2>/dev/null || true
  done
  [[ -S $_TABCAT_SOCKET ]]
}

# Starts a daemon, at most three times per shell. The flock keeps ten terminals
# opening at once from spawning ten daemons; the daemon itself also refuses to
# start twice, so the lock is an optimisation, not the guarantee.
#
# A spawn that has not produced a socket YET is not a failure: the next
# keystroke retries, and the plugin only gives up when the binary is missing or
# repeated spawns lead nowhere.
_tabcat_spawn() {
  local -F now=${EPOCHREALTIME:-0}
  if (( _TABCAT_SPAWN_AT > 0 && now - _TABCAT_SPAWN_AT < TABCAT_SPAWN_GRACE )); then
    # A spawn is already in flight (this shell or another). Do NOT wait here:
    # this runs per keystroke, and a booting daemon would add its latency to
    # every one of them. The suggestion simply shows up once it is listening.
    [[ -S $_TABCAT_SOCKET ]]
    return $?
  fi
  if (( _TABCAT_SPAWNS >= 3 )); then
    # The usual cause is a ${TABCAT_BIN} that predates the daemon command, e.g.
    # an older global install shadowing a checkout.
    _tabcat_disable "daemon could not be started — run '${TABCAT_BIN} daemon' to see why, or '${TABCAT_BIN} plugin init zsh --check'"
    return 1
  fi
  (( ++_TABCAT_SPAWNS ))
  (( $+commands[${TABCAT_BIN}] )) || { _tabcat_disable "${TABCAT_BIN} is not in PATH"; return 1 }

  local dir=${_TABCAT_SOCKET:h}
  [[ -d $dir ]] || mkdir -p -m 700 $dir 2>/dev/null || return 1

  if ! _tabcat_take_spawn_lock; then
    # Another shell holds the spawn lock — just wait for its socket.
    _tabcat_await_socket
    return $?
  fi

  _tabcat_launch
  local outcome=0
  _tabcat_await_socket || outcome=1
  _tabcat_release_spawn_lock
  return $outcome
}

# `zsystem flock` takes a FILE and hands back the fd via -f — passing an fd as
# the argument makes it try to open a file called "14". Returns 1 when another
# shell already holds the lock, i.e. is starting a daemon right now.
_tabcat_take_spawn_lock() {
  _TABCAT_LOCKFD=''
  (( $+builtins[zsystem] )) || return 0
  local lock=${_TABCAT_SOCKET:h}/spawn.lock
  # zsystem flock opens but never CREATES the file: without this the very first
  # spawn on a fresh machine fails the lock and no daemon is ever started.
  [[ -e $lock ]] || : >>$lock 2>/dev/null || return 0
  local fd
  zsystem flock -t 0 -f fd $lock 2>/dev/null || return 1
  _TABCAT_LOCKFD=$fd
  return 0
}

_tabcat_release_spawn_lock() {
  [[ -n $_TABCAT_LOCKFD ]] && zsystem flock -u $_TABCAT_LOCKFD 2>/dev/null
  _TABCAT_LOCKFD=''
  return 0
}

# nohup and `&!`: the daemon outlives the shell that started it. Without an
# ignored SIGHUP it dies with the terminal that happened to spawn it — and it
# cannot install its own handler during Node's startup.
_tabcat_launch() {
  _TABCAT_SPAWN_AT=${EPOCHREALTIME:-0}
  if (( $+commands[nohup] )); then
    ( nohup ${TABCAT_BIN} daemon </dev/null >/dev/null 2>&1 &! )
  else
    ( ${TABCAT_BIN} daemon </dev/null >/dev/null 2>&1 &! )
  fi
}

# Fire and forget at shell startup: by the time anything is typed the daemon is
# listening, so no keystroke ever waits for a Node cold start. Costs one fork in
# the first shell; later shells see the socket and do nothing.
_tabcat_warm_daemon() {
  (( TABCAT_WARM_ON_LOAD )) || return 0
  [[ -S $_TABCAT_SOCKET ]] && return 0
  (( $+commands[${TABCAT_BIN}] )) || return 0
  local dir=${_TABCAT_SOCKET:h}
  [[ -d $dir ]] || mkdir -p -m 700 $dir 2>/dev/null || return 0
  # Another shell starting at the same moment already handles it.
  _tabcat_take_spawn_lock || return 0
  (( ++_TABCAT_SPAWNS ))
  _tabcat_launch
  _tabcat_release_spawn_lock
  return 0
}

_tabcat_connect() {
  (( _TABCAT_OFF )) && return 1
  [[ $_TABCAT_FD != 0 ]] && return 0
  if ! zsocket $_TABCAT_SOCKET 2>/dev/null; then
    _tabcat_spawn || return 1
    zsocket $_TABCAT_SOCKET 2>/dev/null || return 1
  fi
  _TABCAT_FD=$REPLY
  return 0
}

# Sends one request and fills _TABCAT_ROWS with the response rows (raw, still
# escaped). Returns non-zero on any problem — callers fall back silently.
_tabcat_request() {
  (( _TABCAT_OFF )) && return 1
  _tabcat_connect || return 1

  local op=$1
  shift
  local id="z$(( ++_TABCAT_SEQ ))"
  local payload="${op}	${id}	${_TABCAT_PROTOCOL}"
  local field
  for field in "$@"; do
    payload+="	${field}"
  done

  if ! print -r -u$_TABCAT_FD -- $payload 2>/dev/null; then
    _tabcat_drop_fd
    return 1
  fi

  _TABCAT_ROWS=()
  local reply
  while true; do
    # IFS= keeps leading/trailing tabs, i.e. empty first and last fields.
    if ! IFS= read -r -t $TABCAT_TIMEOUT -u$_TABCAT_FD reply 2>/dev/null; then
      # Timeout or EOF. The fd is now out of sync: a late answer would be read
      # as the response to the NEXT request and show a stale ghost.
      _tabcat_drop_fd
      return 1
    fi
    [[ -z $reply ]] && break
    _TABCAT_ROWS+=($reply)
  done

  local -a header=("${(@ps:\t:)_TABCAT_ROWS[1]}")
  if [[ ${header[2]} != $id ]]; then
    # Should be impossible (one request at a time per fd), but a desynced fd
    # must not be trusted.
    _tabcat_drop_fd
    return 1
  fi
  if [[ ${header[1]} == err ]]; then
    case ${header[3]} in
      bad_protocol) _tabcat_disable "daemon speaks a different protocol (${header[4]})" ;;
      warming) ;;  # normal right after a cold start
    esac
    return 1
  fi
  return 0
}

# ---------------------------------------------------------------------------
# Engine calls
# ---------------------------------------------------------------------------

# _TABCAT_ROWS[1] = header (ok, id, prefix, handle), rest = candidates.
_tabcat_predict() {
  local limit=$1
  local REPLY line cwd
  _tabcat_esc $BUFFER; line=$REPLY
  _tabcat_esc $PWD; cwd=$REPLY
  _tabcat_request predict $limit $CURSOR $cwd $line
}

_tabcat_candidate() {
  local -a fields=("${(@ps:\t:)_TABCAT_ROWS[$1]}")
  local REPLY
  _tabcat_dec ${fields[1]}; _TABCAT_C_INSERT=$REPLY
  _tabcat_dec ${fields[2]}; _TABCAT_C_DISPLAY=$REPLY
  _TABCAT_C_SOURCE=${fields[3]}
  _tabcat_dec ${fields[4]}; _TABCAT_C_NAME=$REPLY
  _TABCAT_C_REPLACE=${fields[5]:-0}
}

# Sets REPLY — see _tabcat_ghost_for_candidate: no forks on the keystroke path.
_tabcat_header_handle() {
  local -a header=("${(@ps:\t:)_TABCAT_ROWS[1]}")
  _tabcat_dec ${header[4]:-}
}

# ---------------------------------------------------------------------------
# Ghost text
# ---------------------------------------------------------------------------

_tabcat_clear_ghost() {
  POSTDISPLAY=''
  _TABCAT_GHOST_TEXT=''
}

# POSTDISPLAY can only append — it cannot rewrite characters already on screen.
# So a candidate whose `display` corrects what was typed ("doc" -> "Documents/")
# gets NO ghost: appending its remainder would show "docuMents"-style nonsense
# that differs from what Tab actually inserts. Tab and the menu still offer it.
# Sets REPLY instead of printing: this runs on every keystroke, and a command
# substitution would fork a subshell each time.
_tabcat_ghost_for_candidate() {
  local display=$_TABCAT_C_DISPLAY
  local replace=$_TABCAT_C_REPLACE
  REPLY=''
  if (( replace <= 0 )); then
    REPLY=$display
    return 0
  fi
  local typed=${BUFFER[$(( CURSOR - replace + 1 )),$CURSOR]}
  # Quoted RHS: the typed text may contain glob characters.
  [[ "${display[1,${#typed}]}" == "$typed" ]] && REPLY=${display[$(( ${#typed} + 1 )),-1]}
  return 0
}

_tabcat_ghost() {
  _tabcat_clear_ghost
  (( TABCAT_GHOST )) || return 0
  (( _TABCAT_OFF )) && return 0
  [[ -z $BUFFER ]] && return 0
  # Only at the end of the line: a ghost behind a mid-line cursor is noise.
  (( CURSOR == ${#BUFFER} )) || return 0

  _tabcat_predict 1 || return 0

  local ghost='' badge='' REPLY
  if (( ${#_TABCAT_ROWS} > 1 )); then
    local _TABCAT_C_INSERT _TABCAT_C_DISPLAY _TABCAT_C_SOURCE _TABCAT_C_NAME _TABCAT_C_REPLACE
    _tabcat_candidate 2
    _tabcat_ghost_for_candidate
    ghost=$REPLY
  fi
  if (( TABCAT_BADGE )); then
    _tabcat_header_handle
    [[ -n $REPLY ]] && badge=" ⚡${REPLY}"
  fi

  _TABCAT_GHOST_TEXT=$ghost
  # One writer for POSTDISPLAY: ghost and badge are composed, never appended
  # by two independent code paths.
  POSTDISPLAY="${ghost}${badge}"
  [[ -n $POSTDISPLAY ]] && region_highlight+=("P0 ${#POSTDISPLAY} ${TABCAT_GHOST_STYLE}")
  # Explicit success: a widget that returns non-zero makes zle beep, and "no
  # suggestion for this line" is not an error.
  return 0
}

# ---------------------------------------------------------------------------
# Undo stack for Shift+Tab
# ---------------------------------------------------------------------------

_tabcat_push_undo() {
  _TABCAT_UNDO_BUFFERS+=($BUFFER)
  _TABCAT_UNDO_CURSORS+=($CURSOR)
  # Keep it small: this undoes accepts, it is not a general edit history.
  if (( ${#_TABCAT_UNDO_BUFFERS} > 20 )); then
    shift _TABCAT_UNDO_BUFFERS
    shift _TABCAT_UNDO_CURSORS
  fi
}

# ---------------------------------------------------------------------------
# Widgets
# ---------------------------------------------------------------------------

# Replaces `replace` characters left of the cursor with `text`.
_tabcat_apply() {
  local text=$1 replace=$2
  local keep=$(( CURSOR - replace ))
  (( keep < 0 )) && keep=0
  local head=${BUFFER[1,$keep]}
  local tail=${BUFFER[$(( CURSOR + 1 )),-1]}
  BUFFER="${head}${text}${tail}"
  CURSOR=$(( keep + ${#text} ))
}

tabcat-tab() {
  if ! _tabcat_predict $TABCAT_MENU_LIMIT || (( ${#_TABCAT_ROWS} < 2 )); then
    _tabcat_fallback_tab
    return
  fi
  local _TABCAT_C_INSERT _TABCAT_C_DISPLAY _TABCAT_C_SOURCE _TABCAT_C_NAME _TABCAT_C_REPLACE
  _tabcat_candidate 2
  if [[ -z $_TABCAT_C_INSERT && -z $_TABCAT_C_DISPLAY ]]; then
    _tabcat_fallback_tab
    return
  fi
  _tabcat_push_undo
  # `display` replaces the typed prefix — that is how a case-insensitive match
  # corrects the spelling ("doc" -> "Documents").
  _tabcat_apply $_TABCAT_C_DISPLAY $_TABCAT_C_REPLACE
  _tabcat_ghost
}

# Hands the key to whatever owned Tab before us instead of reimplementing
# completion. Without this, fzf-tab and custom compsys setups would break.
_tabcat_fallback_tab() {
  _tabcat_clear_ghost
  if [[ -n $_TABCAT_ORIG_TAB ]] && zle -l $_TABCAT_ORIG_TAB 2>/dev/null; then
    zle $_TABCAT_ORIG_TAB
  else
    zle expand-or-complete
  fi
}

# One chunk instead of the whole suggestion — the arrow key equivalent of the
# REPL's forward accept.
tabcat-forward-chunk() {
  if (( CURSOR < ${#BUFFER} )) || [[ -z $_TABCAT_GHOST_TEXT ]]; then
    zle .forward-char
    return
  fi
  local ghost=$_TABCAT_GHOST_TEXT
  local lead=${ghost%%[^[:space:]]*}
  local rest=${ghost#$lead}
  local word=${rest%%[[:space:]]*}
  local after=${rest#$word}
  local trail=${after%%[^[:space:]]*}
  local chunk="${lead}${word}${trail}"
  [[ -z $chunk ]] && chunk=$ghost
  _tabcat_push_undo
  _tabcat_apply $chunk 0
  _tabcat_ghost
}

tabcat-undo-accept() {
  if (( ${#_TABCAT_UNDO_BUFFERS} == 0 )); then
    zle -M "tabcat: nothing to undo"
    return
  fi
  BUFFER=${_TABCAT_UNDO_BUFFERS[-1]}
  CURSOR=${_TABCAT_UNDO_CURSORS[-1]}
  _TABCAT_UNDO_BUFFERS[-1]=()
  _TABCAT_UNDO_CURSORS[-1]=()
  _tabcat_ghost
}

# Enter: expand an exact magic-name handle before running it. This has to be a
# widget — preexec runs after the command line is fixed and cannot rewrite it.
tabcat-accept-line() {
  _tabcat_clear_ghost
  local candidate=${BUFFER##[[:space:]]##}
  candidate=${candidate%%[[:space:]]##}
  if [[ $candidate =~ '^[a-z][a-z0-9]{2,15}$' ]]; then
    local REPLY cwd handle
    _tabcat_esc $PWD; cwd=$REPLY
    _tabcat_esc $candidate; handle=$REPLY
    if _tabcat_request names resolve $cwd $handle ''; then
      local -a header=("${(@ps:\t:)_TABCAT_ROWS[1]}")
      _tabcat_dec ${header[3]:-}
      [[ -n $REPLY ]] && BUFFER=$REPLY && CURSOR=${#BUFFER}
    fi
  fi
  zle .accept-line
}

tabcat-label() {
  local line=$BUFFER
  if [[ -z ${line//[[:space:]]/} ]]; then
    zle -M "tabcat: nothing to name"
    return
  fi
  local REPLY
  read-from-minibuffer "tabcat handle (3-16, a-z0-9): " || return
  local handle=${REPLY//[[:space:]]/}
  [[ -z $handle ]] && return
  if [[ ! $handle =~ '^[a-z][a-z0-9]{2,15}$' ]]; then
    zle -M "tabcat: '$handle' is not a valid handle (start with a letter, 3-16 of a-z0-9)"
    return
  fi
  local cwd escaped
  _tabcat_esc $PWD; cwd=$REPLY
  _tabcat_esc $line; escaped=$REPLY
  local escaped_handle
  _tabcat_esc $handle; escaped_handle=$REPLY
  if _tabcat_request names create $cwd $escaped_handle $escaped; then
    zle -M "tabcat: ⚡$handle -> $line"
  else
    local -a header=("${(@ps:\t:)_TABCAT_ROWS[1]:-}")
    zle -M "tabcat: handle rejected (${header[4]:-no daemon})"
  fi
  _tabcat_ghost
}

tabcat-forget() {
  local target=$BUFFER
  local REPLY cwd
  _tabcat_esc $PWD; cwd=$REPLY
  local candidate=${target//[[:space:]]/}
  # A handle in the buffer is forgotten by resolving it first — the tombstone
  # is keyed on the command line, not on the handle.
  if [[ $candidate =~ '^[a-z][a-z0-9]{2,15}$' ]]; then
    local escaped_handle
    _tabcat_esc $candidate; escaped_handle=$REPLY
    if _tabcat_request names resolve $cwd $escaped_handle ''; then
      local -a header=("${(@ps:\t:)_TABCAT_ROWS[1]}")
      _tabcat_dec ${header[3]:-}
      [[ -n $REPLY ]] && target=$REPLY
    fi
  fi
  if [[ -z ${target//[[:space:]]/} ]]; then
    zle -M "tabcat: nothing to forget"
    return
  fi
  local escaped
  _tabcat_esc $target; escaped=$REPLY
  if _tabcat_request names delete $cwd '' $escaped; then
    local -a header=("${(@ps:\t:)_TABCAT_ROWS[1]}")
    if [[ ${header[3]} == deleted ]]; then
      zle -M "tabcat: forgot the handle for $target"
    else
      zle -M "tabcat: no handle on $target"
    fi
  else
    zle -M "tabcat: forget failed (no daemon?)"
  fi
  _tabcat_ghost
}

# Fuzzy history: same ranking as the REPL's own search. Not an incremental
# loop yet — a query, the best hit in the buffer, the alternatives listed.
tabcat-query() {
  local REPLY
  read-from-minibuffer "tabcat search: " || return
  local query=$REPLY cwd escaped
  _tabcat_esc $PWD; cwd=$REPLY
  _tabcat_esc $query; escaped=$REPLY
  if ! _tabcat_request search $TABCAT_SEARCH_LIMIT $cwd $escaped; then
    zle -M "tabcat: search unavailable"
    return
  fi
  if (( ${#_TABCAT_ROWS} < 2 )); then
    zle -M "tabcat: no match for '$query'"
    return
  fi
  local -a hits=()
  local i
  for (( i = 2; i <= ${#_TABCAT_ROWS}; i++ )); do
    _tabcat_dec ${_TABCAT_ROWS[$i]}
    hits+=($REPLY)
  done
  _tabcat_push_undo
  BUFFER=${hits[1]}
  CURSOR=${#BUFFER}
  (( ${#hits} > 1 )) && zle -M "${(F)hits[2,-1]}"
  _tabcat_ghost
}

# Candidate list as a real completion menu: compadd + menu-select, so the
# user's complist settings and key bindings apply unchanged.
_tabcat_menu_completer() {
  _tabcat_predict $TABCAT_MENU_LIMIT || return 1
  (( ${#_TABCAT_ROWS} > 1 )) || return 1
  local -a displays=()
  local i
  local _TABCAT_C_INSERT _TABCAT_C_DISPLAY _TABCAT_C_SOURCE _TABCAT_C_NAME _TABCAT_C_REPLACE
  for (( i = 2; i <= ${#_TABCAT_ROWS}; i++ )); do
    _tabcat_candidate $i
    [[ -n $_TABCAT_C_DISPLAY ]] && displays+=($_TABCAT_C_DISPLAY)
  done
  (( ${#displays} )) || return 1
  compstate[insert]=menu
  # -U: our candidates are ranked by the engine, not filtered by compsys.
  compadd -Q -U -a displays
}

# ---------------------------------------------------------------------------
# Learning
# ---------------------------------------------------------------------------

# Commands the user deliberately keeps out of the shell history must not end up
# in tabcat's history either. A leading space with hist_ignore_space is the
# standard way to hide a secret; HISTORY_IGNORE is the pattern form.
_tabcat_should_learn() {
  local line=$1
  [[ -n ${TABCAT_NO_LEARN:-} ]] && return 1
  [[ -z ${line//[[:space:]]/} ]] && return 1
  if [[ -o hist_ignore_space && $line == [[:space:]]* ]]; then
    return 1
  fi
  if [[ -o hist_no_store ]]; then
    # Array context on purpose: ${${(z)line}[1]} indexes the joined string and
    # would yield the first CHARACTER.
    local -a words=(${(z)line})
    [[ ${words[1]} == (history|fc) ]] && return 1
  fi
  if [[ -n ${HISTORY_IGNORE:-} ]]; then
    [[ $line == ${~HISTORY_IGNORE} ]] && return 1
  fi
  return 0
}

# cwd is captured HERE, not in precmd: `cd build && make` would otherwise be
# attributed to the directory the command changed into. tabcat learns where a
# command was typed.
_tabcat_preexec() {
  _TABCAT_PENDING_LINE=$1
  _TABCAT_PENDING_CWD=$PWD
}

_tabcat_precmd() {
  # MUST be the first statement: any other command overwrites $?. This function
  # is also forced to the front of precmd_functions, because a prompt like
  # starship would otherwise consume the exit code before us.
  local exit_code=$?
  local line=$_TABCAT_PENDING_LINE cwd=$_TABCAT_PENDING_CWD
  # Clear the stash so a bare Enter does not learn the previous line twice.
  _TABCAT_PENDING_LINE=''
  _TABCAT_PENDING_CWD=''
  [[ -z $line ]] && return 0
  (( _TABCAT_OFF )) && return 0
  _tabcat_should_learn $line || return 0

  (( exit_code < 0 || exit_code > 4096 )) && exit_code=1
  # Declared integer, so the float is truncated on assignment: `int()` would
  # need zsh/mathfunc, which is not guaranteed to be available.
  integer ts=0
  if (( ${+EPOCHREALTIME} )); then
    ts=$(( EPOCHREALTIME * 1000 ))
  elif (( ${+EPOCHSECONDS} )); then
    ts=$(( EPOCHSECONDS * 1000 ))
  else
    ts=$(( $(date +%s) * 1000 ))
  fi
  (( ts > 0 )) || return 0

  local REPLY escaped_line escaped_cwd
  _tabcat_esc $line; escaped_line=$REPLY
  _tabcat_esc ${cwd:-$PWD}; escaped_cwd=$REPLY
  # Fire and forget: the answer is read (an unread response would desync the
  # fd) but any failure is silent. The prompt never waits on this.
  _tabcat_request learn $exit_code $ts $escaped_cwd $escaped_line >/dev/null 2>&1
  return 0
}

# ---------------------------------------------------------------------------
# Widget wrapping
# ---------------------------------------------------------------------------

_tabcat_after_widget() {
  local original=$1
  shift
  local outcome=0
  zle $original -- "$@" || outcome=$?
  _tabcat_ghost
  return $outcome
}

_tabcat_wrap_widget() {
  local widget=$1
  local original="tabcat-orig-${widget}"
  [[ -n ${widgets[$widget]:-} ]] || return 0
  [[ ${widgets[$widget]} == user:_tabcat_wrapped_* ]] && return 0

  case ${widgets[$widget]} in
    user:*)
      zle -N $original ${widgets[$widget]#user:}
      ;;
    builtin)
      functions[_tabcat_builtin_${widget}]="zle .${widget} -- \"\$@\""
      zle -N $original _tabcat_builtin_${widget}
      ;;
    *)
      # completion:* and anything unknown stays untouched — re-binding a
      # completion widget is how plugins break each other's Tab.
      return 0
      ;;
  esac

  functions[_tabcat_wrapped_${widget}]="_tabcat_after_widget ${original} \"\$@\""
  zle -N $widget _tabcat_wrapped_${widget}
}

# ---------------------------------------------------------------------------
# Conflict detection
# ---------------------------------------------------------------------------

# Free, or already ours: re-sourcing .zshrc must not warn about bindings this
# plugin installed itself.
_tabcat_key_available() {
  local key=$1
  local -a binding=(${(z)"$(bindkey $key)"})
  [[ ${#binding} -lt 2 || ${binding[2]} == undefined-key || ${binding[2]} == tabcat-* ]]
}

_tabcat_report_conflicts() {
  local -a problems=()
  if (( TABCAT_GHOST )) && (( $+functions[_zsh_autosuggest_start] )); then
    problems+=("zsh-autosuggestions also writes POSTDISPLAY — set TABCAT_GHOST=0 or remove one of them")
  fi
  (( ${#problems} )) || return 0
  local problem
  for problem in $problems; do
    print -u2 "tabcat: $problem"
  done
  if [[ -z ${TABCAT_FORCE:-} ]]; then
    print -u2 "tabcat: set TABCAT_FORCE=1 to load anyway."
    return 1
  fi
  return 0
}

# ---------------------------------------------------------------------------
# Setup
# ---------------------------------------------------------------------------

_tabcat_setup() {
  if [[ -n $TABCAT_SOCKET ]]; then
    _TABCAT_SOCKET=$TABCAT_SOCKET
  else
    local REPLY
    _tabcat_socket_path
    _TABCAT_SOCKET=$REPLY
  fi

  _tabcat_report_conflicts || return 1

  # Remember who owned Tab before us so the fallback can hand the key back.
  # Re-sourcing .zshrc would otherwise capture tabcat-tab itself and turn the
  # fallback into infinite recursion.
  local -a tab_binding=(${(z)"$(bindkey '^I')"})
  local previous=${tab_binding[2]:-}
  if [[ ${#tab_binding} -ge 2 && $previous != undefined-key && $previous != tabcat-* ]]; then
    _TABCAT_ORIG_TAB=$previous
  elif [[ -z $_TABCAT_ORIG_TAB || $_TABCAT_ORIG_TAB == tabcat-* ]]; then
    _TABCAT_ORIG_TAB=expand-or-complete
  fi

  local widget
  for widget in $TABCAT_FETCH_WIDGETS; do
    _tabcat_wrap_widget $widget
  done

  zle -N tabcat-tab
  zle -N tabcat-forward-chunk
  zle -N tabcat-undo-accept
  zle -N tabcat-accept-line
  zle -N tabcat-label
  zle -N tabcat-forget
  zle -N tabcat-query
  # The candidate menu is optional: without zsh/complist there is no
  # menu-select widget to build on, and everything else still works.
  if zle -la menu-select 2>/dev/null || (( $+modules[zsh/complist] )); then
    zle -C tabcat-menu menu-select _tabcat_menu_completer 2>/dev/null
  fi

  bindkey '^I' tabcat-tab
  bindkey '^M' tabcat-accept-line
  bindkey '^J' tabcat-accept-line
  # Both sequences: not every terminal sends the terminfo one.
  bindkey '^[[Z' tabcat-undo-accept
  [[ -n ${terminfo[kcbt]:-} ]] && bindkey "${terminfo[kcbt]}" tabcat-undo-accept
  bindkey "${terminfo[kcuf1]:-^[[C}" tabcat-forward-chunk
  bindkey '^[[C' tabcat-forward-chunk

  local -A chords=(
    [$TABCAT_KEY_LABEL]=tabcat-label
    [$TABCAT_KEY_FORGET]=tabcat-forget
    [$TABCAT_KEY_QUERY]=tabcat-query
    [$TABCAT_KEY_MENU]=tabcat-menu
  )
  local chord
  for chord in ${(k)chords}; do
    [[ -z $chord ]] && continue
    zle -l ${chords[$chord]} 2>/dev/null || continue
    if _tabcat_key_available $chord || [[ -n ${TABCAT_FORCE:-} ]]; then
      bindkey $chord ${chords[$chord]}
    else
      print -u2 "tabcat: $chord is already bound — skipped (rebind via TABCAT_KEY_*)"
    fi
  done

  _tabcat_warm_daemon

  add-zsh-hook preexec _tabcat_preexec
  add-zsh-hook precmd _tabcat_precmd
  # Order matters more than registration: $? must reach us before another
  # precmd hook (starship, omz) runs a command and overwrites it.
  precmd_functions=(_tabcat_precmd ${precmd_functions:#_tabcat_precmd})
  return 0
}

if [[ -z ${TABCAT_PLUGIN_NO_SETUP:-} ]]; then
  _tabcat_setup || _TABCAT_OFF=1
fi
