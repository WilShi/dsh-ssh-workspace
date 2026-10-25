package main

import (
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"sort"
	"strconv"
	"strings"
	"syscall"
	"time"
)

const version = 10

var stateRoot string
var terminalRoot string

type fileInfo struct {
	Kind    string `json:"kind"`
	Size    int64  `json:"size"`
	MtimeMs int64  `json:"mtimeMs"`
	Mode    uint32 `json:"mode"`
}

func emit(value any) {
	encoder := json.NewEncoder(os.Stdout)
	encoder.SetEscapeHTML(false)
	if err := encoder.Encode(value); err != nil {
		fail(err.Error(), 1)
	}
}

func fail(message string, code int) {
	fmt.Fprintln(os.Stderr, message)
	os.Exit(code)
}

func exists(name string) bool { _, err := exec.LookPath(name); return err == nil }

func regularInfo(path string) *fileInfo {
	value, err := os.Lstat(path)
	if os.IsNotExist(err) {
		return nil
	}
	if err != nil {
		fail(err.Error(), 1)
	}
	kind := "other"
	if value.Mode().IsRegular() {
		kind = "file"
	} else if value.IsDir() {
		kind = "directory"
	} else if value.Mode()&os.ModeSymlink != 0 {
		kind = "symlink"
	}
	return &fileInfo{Kind: kind, Size: value.Size(), MtimeMs: value.ModTime().UnixNano() / int64(time.Millisecond), Mode: uint32(value.Mode())}
}

func decodeExcludes(value string) map[string]bool {
	result := map[string]bool{}
	if value == "" {
		return result
	}
	raw, err := base64.RawURLEncoding.DecodeString(value)
	if err != nil {
		fail("invalid exclusions", 1)
	}
	var rows []string
	if json.Unmarshal(raw, &rows) != nil {
		fail("invalid exclusions", 1)
	}
	for _, row := range rows {
		result[row] = true
	}
	return result
}

func walk(root string, excludes map[string]bool, visit func(string, string, *fileInfo)) {
	var next func(string, string)
	next = func(relative, absolute string) {
		rows, err := os.ReadDir(absolute)
		if err != nil {
			fail(err.Error(), 1)
		}
		sort.Slice(rows, func(i, j int) bool { return rows[i].Name() < rows[j].Name() })
		for _, row := range rows {
			name := row.Name()
			if excludes[name] || strings.HasPrefix(name, ".dsh-sync-") {
				continue
			}
			childRelative := name
			if relative != "" {
				childRelative = relative + "/" + name
			}
			child := filepath.Join(absolute, name)
			info := regularInfo(child)
			if info == nil {
				continue
			}
			visit(childRelative, child, info)
			if info.Kind == "directory" {
				next(childRelative, child)
			}
		}
	}
	next("", root)
}

func snapshot(root string, excludes map[string]bool) string {
	digest := sha256.New()
	walk(root, excludes, func(relative, _ string, info *fileInfo) {
		fmt.Fprintf(digest, "%s\x00%d:%d:%s\n", relative, info.Size, info.MtimeMs, info.Kind)
	})
	return hex.EncodeToString(digest.Sum(nil))
}

func commandProbe(_ []string) {
	hostname, _ := os.Hostname()
	emit(map[string]any{
		"version": version, "platform": runtime.GOOS, "hostname": hostname, "python": runtime.Version(),
		"tmux": exists("tmux"), "inotifywait": false, "ss": exists("ss") || exists("netstat"),
	})
}

func commandRealpath(args []string) {
	if len(args) != 1 {
		fail("realpath requires one path", 1)
	}
	path, err := filepath.EvalSymlinks(args[0])
	if err != nil {
		fail(err.Error(), 1)
	}
	path, err = filepath.Abs(path)
	if err != nil {
		fail(err.Error(), 1)
	}
	info, err := os.Stat(path)
	if err != nil || !info.IsDir() {
		fail("remote directory does not exist", 1)
	}
	emit(map[string]any{"path": path})
}

func commandStat(args []string) {
	if len(args) != 1 {
		fail("stat requires one path", 1)
	}
	emit(map[string]any{"stat": regularInfo(args[0])})
}

func commandResolve(args []string) {
	if len(args) != 1 {
		fail("resolve requires one path", 1)
	}
	path, err := filepath.EvalSymlinks(args[0])
	if err != nil {
		fail("remote path does not exist", 1)
	}
	path, err = filepath.Abs(path)
	if err != nil {
		fail(err.Error(), 1)
	}
	emit(map[string]any{"path": path})
}

func commandList(args []string) {
	if len(args) != 2 {
		fail("list requires path and limit", 1)
	}
	limit, err := strconv.Atoi(args[1])
	if err != nil || limit < 1 {
		fail("invalid list limit", 1)
	}
	rows, err := os.ReadDir(args[0])
	if err != nil {
		fail(err.Error(), 1)
	}
	sort.Slice(rows, func(i, j int) bool { return strings.ToLower(rows[i].Name()) < strings.ToLower(rows[j].Name()) })
	if len(rows) > limit+1 {
		rows = rows[:limit+1]
	}
	for _, row := range rows {
		info := regularInfo(filepath.Join(args[0], row.Name()))
		if info != nil {
			emit(map[string]any{"name": row.Name(), "kind": info.Kind, "size": info.Size, "mtimeMs": info.MtimeMs, "mode": info.Mode})
		}
	}
}

func commandSearch(args []string) {
	if len(args) != 4 {
		fail("search requires root, query, limit and exclusions", 1)
	}
	limit, err := strconv.Atoi(args[2])
	if err != nil || limit < 1 {
		fail("invalid search limit", 1)
	}
	needle := strings.ToLower(args[1])
	count := 0
	walk(args[0], decodeExcludes(args[3]), func(relative, _ string, info *fileInfo) {
		if count > limit || !strings.Contains(strings.ToLower(filepath.Base(relative)), needle) {
			return
		}
		emit(map[string]any{"path": filepath.ToSlash(relative), "kind": info.Kind, "size": info.Size, "mtimeMs": info.MtimeMs, "mode": info.Mode})
		count++
	})
}

func commandScan(args []string) {
	if len(args) != 2 {
		fail("scan requires root and exclusions", 1)
	}
	walk(args[0], decodeExcludes(args[1]), func(relative, _ string, info *fileInfo) {
		emit(map[string]any{"path": relative, "kind": info.Kind, "size": info.Size, "mtimeMs": info.MtimeMs, "mode": info.Mode})
	})
}

func hashFile(path string, output io.Writer) (string, int64) {
	before, err := os.Stat(path)
	if err != nil || !before.Mode().IsRegular() {
		fail("not a regular file", 1)
	}
	file, err := os.Open(path)
	if err != nil {
		fail(err.Error(), 1)
	}
	digest := sha256.New()
	written, err := io.Copy(io.MultiWriter(output, digest), file)
	file.Close()
	if err != nil {
		fail(err.Error(), 1)
	}
	after, err := os.Stat(path)
	if err != nil || before.Size() != after.Size() || !before.ModTime().Equal(after.ModTime()) || written != before.Size() {
		fail("file changed while reading", 75)
	}
	return hex.EncodeToString(digest.Sum(nil)), written
}

func commandHash(args []string) {
	if len(args) != 1 {
		fail("hash requires one path", 1)
	}
	hash, size := hashFile(args[0], io.Discard)
	emit(map[string]any{"hash": hash, "size": size})
}

func commandRead(args []string) {
	if len(args) != 1 {
		fail("read requires one path", 1)
	}
	hashFile(args[0], os.Stdout)
}

func commandReadHead(args []string) {
	if len(args) != 2 {
		fail("read-head requires path and maximum size", 1)
	}
	maximum, err := strconv.ParseInt(args[1], 10, 64)
	if err != nil || maximum < 0 {
		fail("invalid maximum size", 1)
	}
	before, err := os.Stat(args[0])
	if err != nil || !before.Mode().IsRegular() {
		fail("not a regular file", 1)
	}
	file, err := os.Open(args[0])
	if err != nil {
		fail(err.Error(), 1)
	}
	_, err = io.CopyN(os.Stdout, file, minInt64(maximum, before.Size()))
	file.Close()
	if err != nil && err != io.EOF {
		fail(err.Error(), 1)
	}
	after, err := os.Stat(args[0])
	if err != nil || before.Size() != after.Size() || !before.ModTime().Equal(after.ModTime()) {
		fail("file changed while reading", 75)
	}
}

func commandReadRange(args []string) {
	if len(args) != 3 {
		fail("read-range requires path, offset, and length", 1)
	}
	offset, offsetErr := strconv.ParseInt(args[1], 10, 64)
	length, lengthErr := strconv.ParseInt(args[2], 10, 64)
	if offsetErr != nil || lengthErr != nil || offset < 0 || length < 0 {
		fail("invalid byte range", 1)
	}
	before, err := os.Stat(args[0])
	if err != nil || !before.Mode().IsRegular() {
		fail("not a regular file", 1)
	}
	file, err := os.Open(args[0])
	if err != nil {
		fail(err.Error(), 1)
	}
	if _, err = file.Seek(offset, io.SeekStart); err != nil {
		file.Close()
		fail(err.Error(), 1)
	}
	available := before.Size() - offset
	if available < 0 {
		available = 0
	}
	_, err = io.CopyN(os.Stdout, file, minInt64(length, available))
	file.Close()
	if err != nil && err != io.EOF {
		fail(err.Error(), 1)
	}
	after, err := os.Stat(args[0])
	if err != nil || before.Size() != after.Size() || !before.ModTime().Equal(after.ModTime()) {
		fail("file changed while reading", 75)
	}
}

func minInt64(left, right int64) int64 {
	if left < right {
		return left
	}
	return right
}

func commandWrite(args []string) {
	if len(args) != 2 {
		fail("write requires path and maximum size", 1)
	}
	maximum, err := strconv.ParseInt(args[1], 10, 64)
	if err != nil {
		fail("invalid maximum size", 1)
	}
	path, err := filepath.Abs(args[0])
	if err != nil {
		fail(err.Error(), 1)
	}
	parent := filepath.Dir(path)
	if os.MkdirAll(parent, 0700) != nil {
		fail("failed to create parent directory", 1)
	}
	temporary, err := os.CreateTemp(parent, ".dsh-upload-")
	if err != nil {
		fail(err.Error(), 1)
	}
	temporaryName := temporary.Name()
	defer os.Remove(temporaryName)
	digest := sha256.New()
	reader := &io.LimitedReader{R: os.Stdin, N: maximum + 1}
	size, copyError := io.Copy(io.MultiWriter(temporary, digest), reader)
	if copyError != nil {
		temporary.Close()
		fail(copyError.Error(), 1)
	}
	if size > maximum {
		temporary.Close()
		fail("file exceeds transfer limit", 76)
	}
	if temporary.Sync() != nil {
		temporary.Close()
		fail("failed to sync upload", 1)
	}
	mode := os.FileMode(0600)
	if existing, error := os.Stat(path); error == nil && existing.Mode().IsRegular() {
		mode = existing.Mode().Perm()
	}
	if temporary.Chmod(mode) != nil {
		temporary.Close()
		fail("failed to apply file mode", 1)
	}
	if temporary.Close() != nil {
		fail("failed to close upload", 1)
	}
	if os.Rename(temporaryName, path) != nil {
		fail("failed to replace destination", 1)
	}
	if directory, error := os.Open(parent); error == nil {
		directory.Sync()
		directory.Close()
	}
	info := regularInfo(path)
	emit(map[string]any{"hash": hex.EncodeToString(digest.Sum(nil)), "size": size, "stat": info})
}

func commandMkdir(args []string) {
	if len(args) != 1 {
		fail("mkdir requires one path", 1)
	}
	if os.MkdirAll(args[0], 0755) != nil {
		fail("mkdir failed", 1)
	}
}
func commandUnlink(args []string) {
	if len(args) != 1 {
		fail("unlink requires one path", 1)
	}
	if err := os.Remove(args[0]); err != nil && !os.IsNotExist(err) {
		fail(err.Error(), 1)
	}
}

func commandRemove(args []string) {
	if len(args) != 2 {
		fail("remove requires path and recursive flag", 1)
	}
	info, err := os.Lstat(args[0])
	if os.IsNotExist(err) {
		return
	}
	if err != nil {
		fail(err.Error(), 1)
	}
	if info.IsDir() {
		if args[1] == "1" {
			err = os.RemoveAll(args[0])
		} else {
			err = os.Remove(args[0])
		}
	} else {
		err = os.Remove(args[0])
	}
	if err != nil {
		fail(err.Error(), 1)
	}
}

func commandRename(args []string) {
	if len(args) != 2 {
		fail("rename requires source and destination", 1)
	}
	if err := os.MkdirAll(filepath.Dir(args[1]), 0755); err != nil {
		fail(err.Error(), 1)
	}
	if err := os.Rename(args[0], args[1]); err != nil {
		fail(err.Error(), 1)
	}
}

func commandWatch(args []string) {
	if len(args) != 3 {
		fail("watch requires root, exclusions, and interval", 1)
	}
	interval, _ := strconv.ParseFloat(args[2], 64)
	if interval < .5 {
		interval = .5
	}
	if interval > 60 {
		interval = 60
	}
	excludes := decodeExcludes(args[1])
	previous := snapshot(args[0], excludes)
	emit(map[string]any{"type": "ready", "backend": "poll"})
	for {
		time.Sleep(time.Duration(interval * float64(time.Second)))
		current := snapshot(args[0], excludes)
		if current != previous {
			previous = current
			emit(map[string]any{"type": "change"})
		}
	}
}

func endpoint(value string) (string, int, bool) {
	index := strings.LastIndex(value, ":")
	if index < 0 {
		return "", 0, false
	}
	host := strings.Trim(value[:index], "[]")
	if host == "*" {
		host = "0.0.0.0"
	}
	port, err := strconv.Atoi(value[index+1:])
	return host, port, err == nil && port > 0
}

func commandPorts(_ []string) {
	var command *exec.Cmd
	if exists("ss") {
		command = exec.Command("ss", "-H", "-ltnp")
	} else if exists("netstat") {
		command = exec.Command("netstat", "-lntp")
	} else {
		return
	}
	output, err := command.Output()
	if err != nil {
		return
	}
	found := map[string]bool{}
	for _, line := range strings.Split(string(output), "\n") {
		fields := strings.Fields(line)
		if len(fields) < 4 {
			continue
		}
		local := ""
		process := ""
		if fields[0] == "LISTEN" {
			local = fields[3]
			if len(fields) > 5 {
				process = fields[5]
			}
		} else if strings.HasPrefix(fields[0], "tcp") && len(fields) >= 6 && fields[5] == "LISTEN" {
			local = fields[3]
			if len(fields) > 6 {
				process = fields[6]
			}
		}
		host, port, ok := endpoint(local)
		key := fmt.Sprintf("%s:%d", host, port)
		if !ok || found[key] {
			continue
		}
		found[key] = true
		value := map[string]any{"host": host, "port": port}
		if process != "" && process != "-" {
			value["process"] = process
		}
		emit(value)
	}
}

func terminalPaths(value string) (string, string, string, string) {
	hash := sha256.Sum256([]byte(value))
	key := hex.EncodeToString(hash[:])[:32]
	directory := filepath.Join(terminalRoot, key)
	return key, directory, filepath.Join(directory, "output.log"), filepath.Join(directory, "lease.json")
}
func tmuxSession(key string) string { return "dsh-" + key[:20] }
func runQuiet(args ...string) int {
	command := exec.Command(args[0], args[1:]...)
	command.Stdout = io.Discard
	command.Stderr = io.Discard
	if error := command.Run(); error != nil {
		if exit, ok := error.(*exec.ExitError); ok {
			return exit.ExitCode()
		}
		return 1
	}
	return 0
}
func tmuxStatus(session string) (bool, int, bool) {
	if runQuiet("tmux", "has-session", "-t", session) != 0 {
		return false, 0, false
	}
	output, err := exec.Command("tmux", "list-panes", "-t", session, "-F", "#{pane_dead} #{pane_dead_status}").Output()
	if err != nil {
		return false, 0, false
	}
	parts := strings.Fields(string(output))
	if len(parts) == 0 {
		return false, 0, false
	}
	code := 0
	if len(parts) > 1 {
		code, _ = strconv.Atoi(parts[1])
	}
	return parts[0] == "0", code, true
}
func shellQuote(value string) string { return "'" + strings.ReplaceAll(value, "'", "'\\''") + "'" }

func capturedDelta(previous, current []byte) []byte {
	if len(previous) == 0 {
		return current
	}
	if strings.HasPrefix(string(current), string(previous)) {
		return current[len(previous):]
	}
	oldLines := strings.SplitAfter(string(previous), "\n")
	newLines := strings.SplitAfter(string(current), "\n")
	maximum := len(oldLines)
	if len(newLines) < maximum {
		maximum = len(newLines)
	}
	for count := maximum; count > 0; count-- {
		matched := true
		for index := 0; index < count; index++ {
			if oldLines[len(oldLines)-count+index] != newLines[index] {
				matched = false
				break
			}
		}
		if matched {
			return []byte(strings.Join(newLines[count:], ""))
		}
	}
	return current
}

func captureTerminal(session, directory, log string) {
	output, err := exec.Command("tmux", "capture-pane", "-p", "-e", "-S", "-100000", "-t", session).Output()
	if err != nil {
		return
	}
	lock, err := os.OpenFile(filepath.Join(directory, "capture.lock"), os.O_CREATE|os.O_RDWR, 0600)
	if err != nil {
		return
	}
	syscall.Flock(int(lock.Fd()), syscall.LOCK_EX)
	snapshot := filepath.Join(directory, "capture.snapshot")
	previous, _ := os.ReadFile(snapshot)
	delta := capturedDelta(previous, output)
	if len(delta) > 0 {
		if target, openError := os.OpenFile(log, os.O_CREATE|os.O_APPEND|os.O_WRONLY, 0600); openError == nil {
			target.Write(delta)
			target.Close()
		}
	}
	temporary := filepath.Join(directory, fmt.Sprintf(".capture-%d", time.Now().UnixNano()))
	if os.WriteFile(temporary, output, 0600) == nil {
		os.Rename(temporary, snapshot)
	} else {
		os.Remove(temporary)
	}
	syscall.Flock(int(lock.Fd()), syscall.LOCK_UN)
	lock.Close()
}

func commandTerminalStart(args []string) {
	if len(args) != 4 {
		fail("terminal-start requires id, cwd, cols, rows", 1)
	}
	if !exists("tmux") {
		fail("tmux is unavailable", 69)
	}
	key, directory, log, lease := terminalPaths(args[0])
	os.MkdirAll(directory, 0700)
	os.Remove(lease)
	session := tmuxSession(key)
	alive, _, present := tmuxStatus(session)
	if present && !alive {
		runQuiet("tmux", "kill-session", "-t", session)
		present = false
	}
	if !present {
		if os.WriteFile(log, []byte{}, 0600) != nil {
			fail("failed to initialize terminal log", 1)
		}
		os.Remove(filepath.Join(directory, "capture.snapshot"))
		runQuiet("tmux", "start-server")
		runQuiet("tmux", "set-option", "-g", "history-limit", "100000")
		cols, _ := strconv.Atoi(args[2])
		rows, _ := strconv.Atoi(args[3])
		if cols < 2 {
			cols = 2
		}
		if rows < 2 {
			rows = 2
		}
		sizeArgs := []string{"new-session", "-d", "-s", session, "-x", strconv.Itoa(cols), "-y", strconv.Itoa(rows)}
		withCwd := append(append([]string{}, sizeArgs...), "-c", args[1])
		if runQuiet(append([]string{"tmux"}, withCwd...)...) != 0 {
			runQuiet("tmux", "kill-session", "-t", session)
			login := "cd -- " + shellQuote(args[1]) + " && exec \"${SHELL:-/bin/sh}\" -l"
			legacy := append(append([]string{}, sizeArgs...), login)
			if runQuiet(append([]string{"tmux"}, legacy...)...) != 0 {
				fail("failed to create tmux session", 1)
			}
		}
		runQuiet("tmux", "set-option", "-t", session, "remain-on-exit", "on")
	}
	info, _ := os.Stat(log)
	offset := int64(0)
	if info != nil {
		offset = info.Size()
	}
	emit(map[string]any{"session": session, "offset": offset})
}

func commandTerminalFollow(args []string) {
	if len(args) != 2 {
		fail("terminal-follow requires id and offset", 1)
	}
	key, directory, log, _ := terminalPaths(args[0])
	session := tmuxSession(key)
	offset, _ := strconv.ParseInt(args[1], 10, 64)
	if offset < 0 {
		offset = 0
	}
	idle := 0
	for {
		captureTerminal(session, directory, log)
		if file, err := os.Open(log); err == nil {
			info, _ := file.Stat()
			if info != nil && offset > info.Size() {
				offset = info.Size()
			}
			file.Seek(offset, io.SeekStart)
			copied, _ := io.Copy(os.Stdout, file)
			offset += copied
			file.Close()
		}
		alive, code, present := tmuxStatus(session)
		if !present || !alive {
			idle++
			if idle >= 4 {
				fmt.Fprintf(os.Stderr, "__DSH_TERMINAL_EXIT__=%d\n", code)
				return
			}
		} else {
			idle = 0
		}
		time.Sleep(250 * time.Millisecond)
	}
}

func commandTerminalInput(args []string) {
	if len(args) != 2 {
		fail("terminal-input requires id and sequence", 1)
	}
	sequence, _ := strconv.ParseInt(args[1], 10, 64)
	key, directory, _, _ := terminalPaths(args[0])
	session := tmuxSession(key)
	alive, _, present := tmuxStatus(session)
	if !present || !alive {
		fail("terminal is not running", 70)
	}
	sequenceFile := filepath.Join(directory, "input-sequence")
	previousRaw, _ := os.ReadFile(sequenceFile)
	previous, _ := strconv.ParseInt(strings.TrimSpace(string(previousRaw)), 10, 64)
	if sequence <= previous {
		return
	}
	buffer := fmt.Sprintf("dsh-%d", time.Now().UnixNano())
	input, err := os.CreateTemp(directory, ".terminal-input-")
	if err != nil {
		fail("failed to create terminal input", 1)
	}
	inputPath := input.Name()
	if _, err = io.Copy(input, os.Stdin); err != nil {
		input.Close()
		os.Remove(inputPath)
		fail("failed to store terminal input", 1)
	}
	input.Sync()
	input.Close()
	loadError := exec.Command("tmux", "load-buffer", "-b", buffer, inputPath).Run()
	pasteCode := 1
	if loadError == nil {
		pasteCode = runQuiet("tmux", "paste-buffer", "-d", "-b", buffer, "-t", session)
	} else {
		// tmux 1.8 only accepts numeric global buffer indexes. Serialize its
		// default buffer to avoid cross-terminal input races.
		lock, lockError := os.OpenFile(filepath.Join(stateRoot, "terminal-input.lock"), os.O_CREATE|os.O_RDWR, 0600)
		if lockError != nil {
			os.Remove(inputPath)
			fail("failed to lock terminal input", 1)
		}
		syscall.Flock(int(lock.Fd()), syscall.LOCK_EX)
		loadError = exec.Command("tmux", "load-buffer", inputPath).Run()
		if loadError == nil {
			pasteCode = runQuiet("tmux", "paste-buffer", "-d", "-t", session)
		}
		syscall.Flock(int(lock.Fd()), syscall.LOCK_UN)
		lock.Close()
	}
	os.Remove(inputPath)
	if loadError != nil {
		fail("failed to load terminal input", 1)
	}
	if pasteCode != 0 {
		fail("failed to deliver terminal input", 1)
	}
	temporary := sequenceFile + fmt.Sprintf(".%d", time.Now().UnixNano())
	os.WriteFile(temporary, []byte(strconv.FormatInt(sequence, 10)), 0600)
	os.Rename(temporary, sequenceFile)
}

func commandTerminalResize(args []string) {
	if len(args) != 3 {
		fail("terminal-resize requires id, cols, rows", 1)
	}
	key, _, _, _ := terminalPaths(args[0])
	runQuiet("tmux", "resize-window", "-t", tmuxSession(key), "-x", args[1], "-y", args[2])
}
func commandTerminalClose(args []string) {
	if len(args) != 1 {
		fail("terminal-close requires id", 1)
	}
	key, directory, _, _ := terminalPaths(args[0])
	runQuiet("tmux", "kill-session", "-t", tmuxSession(key))
	os.RemoveAll(directory)
}

func commandTerminalDetach(args []string) {
	if len(args) != 2 {
		fail("terminal-detach requires id and grace", 1)
	}
	grace, _ := strconv.Atoi(args[1])
	if grace < 30 {
		grace = 30
	}
	if grace > 86400 {
		grace = 86400
	}
	key, directory, _, lease := terminalPaths(args[0])
	alive, _, present := tmuxStatus(tmuxSession(key))
	if !present || !alive {
		return
	}
	os.MkdirAll(directory, 0700)
	token := fmt.Sprintf("%d", time.Now().UnixNano())
	body, _ := json.Marshal(map[string]any{"token": token, "deadline": time.Now().Add(time.Duration(grace) * time.Second).Unix()})
	os.WriteFile(lease, body, 0600)
	executable, _ := os.Executable()
	command := exec.Command(executable, "terminal-reap", args[0], token, strconv.Itoa(grace))
	command.Stdin = nil
	command.Stdout = nil
	command.Stderr = nil
	command.SysProcAttr = &syscall.SysProcAttr{Setsid: true}
	if command.Start() != nil {
		fail("failed to schedule terminal cleanup", 1)
	}
}

func commandTerminalReap(args []string) {
	if len(args) != 3 {
		return
	}
	grace, _ := strconv.Atoi(args[2])
	time.Sleep(time.Duration(grace) * time.Second)
	key, directory, _, lease := terminalPaths(args[0])
	raw, err := os.ReadFile(lease)
	if err != nil {
		return
	}
	var value map[string]any
	if json.Unmarshal(raw, &value) != nil || value["token"] != args[1] {
		return
	}
	runQuiet("tmux", "kill-session", "-t", tmuxSession(key))
	os.RemoveAll(directory)
}

func main() {
	home, err := os.UserHomeDir()
	if err != nil {
		fail("home directory unavailable", 1)
	}
	stateRoot = filepath.Join(home, ".dsh", "ssh-helper")
	terminalRoot = filepath.Join(stateRoot, "terminals")
	os.MkdirAll(terminalRoot, 0700)
	if len(os.Args) < 2 {
		fail("unsupported helper command", 1)
	}
	args := os.Args[2:]
	switch os.Args[1] {
	case "probe":
		commandProbe(args)
	case "realpath":
		commandRealpath(args)
	case "stat":
		commandStat(args)
	case "resolve":
		commandResolve(args)
	case "list":
		commandList(args)
	case "search":
		commandSearch(args)
	case "scan":
		commandScan(args)
	case "hash":
		commandHash(args)
	case "read":
		commandRead(args)
	case "read-head":
		commandReadHead(args)
	case "read-range":
		commandReadRange(args)
	case "write":
		commandWrite(args)
	case "mkdir":
		commandMkdir(args)
	case "unlink":
		commandUnlink(args)
	case "remove":
		commandRemove(args)
	case "rename":
		commandRename(args)
	case "watch":
		commandWatch(args)
	case "ports":
		commandPorts(args)
	case "terminal-start":
		commandTerminalStart(args)
	case "terminal-follow":
		commandTerminalFollow(args)
	case "terminal-input":
		commandTerminalInput(args)
	case "terminal-resize":
		commandTerminalResize(args)
	case "terminal-close":
		commandTerminalClose(args)
	case "terminal-detach":
		commandTerminalDetach(args)
	case "terminal-reap":
		commandTerminalReap(args)
	default:
		fail("unsupported helper command", 1)
	}
}
