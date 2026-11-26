#!/usr/bin/perl
use strict;
use warnings;
use Errno qw(EINTR EPIPE);
use Socket qw(AF_INET SOCK_DGRAM IPPROTO_UDP inet_aton pack_sockaddr_in);

use constant HEADER_BYTES => 6;
use constant MAX_DATAGRAM => 65_507;
use constant MAX_SESSIONS => 64;
use constant SESSION_TTL => 180;

binmode(STDIN, ':raw')  or die "Could not set stdin to binary mode: $!\n";
binmode(STDOUT, ':raw') or die "Could not set stdout to binary mode: $!\n";
$SIG{PIPE} = 'IGNORE';

my $target = pack_sockaddr_in(34_197, inet_aton('127.0.0.1'));
my %sessions;
my $input = '';
my $last_warning = 0;
my $stdin_fd = fileno(STDIN);

sub report_drop {
    my ($message) = @_;
    my $now = time();
    # A failed local server should not turn incoming game traffic into an unbounded log.
    return if $now == $last_warning;
    $last_warning = $now;
    warn "$message\n";
}

sub open_session {
    my ($id) = @_;
    if (scalar(keys %sessions) >= MAX_SESSIONS) {
        report_drop('Factorio UDP peer session limit reached');
        return;
    }
    unless (socket(my $udp, AF_INET, SOCK_DGRAM, IPPROTO_UDP)) {
        report_drop("Factorio UDP socket creation failed: $!");
        return;
    } else {
        unless (connect($udp, $target)) {
            report_drop("Factorio UDP socket connect failed: $!");
            return;
        }
        return $sessions{$id} = { socket => $udp, active_at => time() };
    }
}

sub forward_to_game {
    my ($id, $datagram) = @_;
    my $session = $sessions{$id} || open_session($id);
    return unless $session;

    $session->{active_at} = time();
    my $sent;
    do {
        $sent = send($session->{socket}, $datagram, 0);
    } while (!defined($sent) && $! == EINTR);
    report_drop("Factorio UDP send failed: $!") unless defined($sent);
}

sub send_frame {
    my ($id, $datagram) = @_;
    my $frame = pack('Nn', $id, length($datagram)) . $datagram;
    my $offset = 0;
    while ($offset < length($frame)) {
        my $written = syswrite(STDOUT, $frame, length($frame) - $offset, $offset);
        if (!defined($written)) {
            next if $! == EINTR;
            exit 0 if $! == EPIPE;
            die "Writing a Factorio UDP frame failed: $!\n";
        }
        die "Writing a Factorio UDP frame made no progress\n" unless $written;
        $offset += $written;
    }
}

print STDERR "Factorio UDP peer ready for 127.0.0.1:34197\n";
while (1) {
    my $now = time();
    for my $id (keys %sessions) {
        if ($now - $sessions{$id}->{active_at} >= SESSION_TTL) {
            close(delete($sessions{$id})->{socket});
        }
    }

    my $ready = '';
    vec($ready, $stdin_fd, 1) = 1;
    for my $session (values %sessions) {
        vec($ready, fileno($session->{socket}), 1) = 1;
    }

    my $selected = select($ready, undef, undef, 5);
    if ($selected < 0) {
        next if $! == EINTR;
        die "Waiting for Factorio UDP traffic failed: $!\n";
    }
    next unless $selected;

    if (vec($ready, $stdin_fd, 1)) {
        my $read = sysread(STDIN, my $chunk, 65_536);
        if (!defined($read)) {
            next if $! == EINTR;
            die "Reading a Factorio UDP frame failed: $!\n";
        }
        if ($read == 0) {
            die "Truncated Factorio UDP frame at EOF\n" if length($input);
            exit 0;
        }
        $input .= $chunk;
        while (length($input) >= HEADER_BYTES) {
            my ($id, $length) = unpack('Nn', substr($input, 0, HEADER_BYTES));
            die "Invalid Factorio UDP frame length: $length\n" if $length > MAX_DATAGRAM;
            last if length($input) < HEADER_BYTES + $length;
            my $frame = substr($input, 0, HEADER_BYTES + $length, '');
            forward_to_game($id, substr($frame, HEADER_BYTES));
        }
    }

    for my $id (keys %sessions) {
        my $session = $sessions{$id};
        next unless vec($ready, fileno($session->{socket}), 1);
        my $peer = recv($session->{socket}, my $datagram, MAX_DATAGRAM, 0);
        if (!defined($peer)) {
            report_drop("Factorio UDP receive failed: $!") unless $! == EINTR;
            next;
        }
        $session->{active_at} = time();
        send_frame($id, $datagram);
    }
}
