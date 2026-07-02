#[path = "../src/grid.rs"]
mod grid;

use grid::Grid;

#[test]
fn ansi_snapshot_round_trips_visible_screen() {
    let corpus: &[&[u8]] = &[
        b"plain\r\noutput",
        b"\x1b[31mred\x1b[0m normal",
        b"abc\x1b[2;5Hcursor\x1b[1;1Htop",
        "wide: λ café\ncombining: e\u{301}".as_bytes(),
    ];

    for bytes in corpus {
        let mut original = Grid::new(40, 8);
        original.feed(bytes);
        let snapshot = original.serialize_ansi();

        let mut restored = Grid::new(40, 8);
        restored.feed(snapshot.as_bytes());

        assert_eq!(restored.read_screen(), original.read_screen());
    }
}
