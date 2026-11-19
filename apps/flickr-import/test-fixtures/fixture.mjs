export const ids = {
  photo: "9007199254740993",
  video: "9007199254740994",
  pending: "9007199254740995",
};

export const metadataFirst = {
  id: "metadata-1",
  sidecars: [
    {
      name: `photo_${ids.photo}.json`,
      json: {
        id: ids.photo,
        name: "River bend",
        description: "<p>River &amp; rocks</p>",
        original: "https://example.invalid/unrelated-name.jpg",
        date_taken: "2020-03-02 09:05:06",
        date_imported: "2021-05-12 14:35:10",
        geo: [{ latitude: "-23550520", longitude: "-46633308", accuracy: "16" }],
        rotation: 90,
        tags: [{ tag: "Outdoors" }],
        albums: [
          { id: "1", title: "Outdoors" },
          { id: "3", title: "Other" },
          { title: "Missing album ID" },
        ],
      },
    },
    { name: `photo_${ids.video}.json`, json: { id: ids.video, name: "River in motion" } },
    { name: `photo_${ids.pending}.json`, json: { id: ids.pending, name: "Still pending" } },
  ],
};

export const metadataLater = {
  id: "metadata-2",
  albums: [
    { id: "1", title: "Outdoors", photo_count: 100, photos: [ids.pending, ids.photo] },
    { id: "2", title: "Weekend", photos: [ids.photo, ids.video] },
    { id: "3", title: "Other", photos: [] },
  ],
};

export function originalParts(photo, video) {
  return [
    { id: "media-1", media: [{ name: `river_bend_${ids.photo}_o.jpg`, bytes: photo }] },
    { id: "media-2", media: [{ name: `river_motion_${ids.video}_o.jpg`, bytes: video }] },
  ];
}
