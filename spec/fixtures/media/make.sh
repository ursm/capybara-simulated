#!/bin/zsh
# How the H.264 fixtures here were made (ffmpeg with libx264). crash_av1.mp4 and crash.avif are AV1 files with a few
# bytes changed, found by mutation: each made the rav1d decoder panic.
set -e
D=${0:A:h}
mkdir -p $D
F='-hide_banner -loglevel error -y'
# a red-left / blue-right frame, 1 s
ffmpeg ${=F} -f lavfi -i "color=c=red:s=1920x1080:d=1" -vf "drawbox=x=960:y=0:w=960:h=1080:color=blue:t=fill" -c:v libx264 -pix_fmt yuv420p $D/hd.mp4
ffmpeg ${=F} -i $D/hd.mp4 -c copy -movflags frag_keyframe+empty_moov+default_base_moof $D/frag.mp4
ffmpeg ${=F} -i $D/hd.mp4 -c copy -display_rotation 90 $D/rot.mp4 || ffmpeg ${=F} -i $D/hd.mp4 -c copy -metadata:s:v rotate=90 $D/rot.mp4
ffmpeg ${=F} -f lavfi -i "color=c=0x808080:s=64x64:d=1" -c:v libx264 -pix_fmt yuvj420p $D/full.mp4
ffmpeg ${=F} -f lavfi -i "color=c=red:s=64x48:d=1" -c:v libx264 -pix_fmt yuv420p -vf "setsar=2/1" $D/sar.mp4
